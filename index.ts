import fs from 'fs'
import axios, { AxiosError } from 'axios'
import * as core from '@actions/core'

// https://docs.microsoft.com/en-us/microsoft-edge/extensions-chromium/publish/api/using-addons-api

async function getAccessToken(clientId: string, clientSecret: string, accessTokenUrl: string): Promise<string> {
  core.info('Start to get access token.')

  // https://docs.microsoft.com/en-us/microsoft-edge/extensions-chromium/publish/api/using-addons-api#retrieving-the-access-token
  const formData = new URLSearchParams()
  formData.append('client_id', clientId)
  formData.append('scope', 'https://api.addons.microsoftedge.microsoft.com/.default')
  formData.append('client_secret', clientSecret)
  formData.append('grant_type', 'client_credentials')

  const response = await axios.post(
    accessTokenUrl,
    formData,
  )

  const accessToken = response.data.access_token
  core.info('Access token got.')
  core.debug('Access token: ' + accessToken)
  return accessToken
}

async function uploadPackage(productId: string, zipPath: string, token: string): Promise<void> {
  core.info('Start to upload package.')

  // https://docs.microsoft.com/en-us/microsoft-edge/extensions-chromium/publish/api/using-addons-api#uploading-a-package-to-update-an-existing-submission
  // https://docs.microsoft.com/en-us/microsoft-edge/extensions-chromium/publish/api/addons-api-reference#upload-a-package-to-update-an-existing-submission
  let url = `https://api.addons.microsoftedge.microsoft.com/v1/products/${productId}/submissions/draft/package`
  const zipStream = fs.createReadStream(zipPath)
  let response = await axios.post(
    url,
    zipStream,
    { headers: { 'Content-Type': 'application/zip', Authorization: `Bearer ${token}` } }
  )

  const operationId = response.headers.location
  core.info('Package uploaded.')
  core.debug('Operation ID: ' + operationId)

  // Wait until package validated
  // https://docs.microsoft.com/en-us/microsoft-edge/extensions-chromium/publish/api/using-addons-api#checking-the-status-of-a-package-upload
  // https://docs.microsoft.com/en-us/microsoft-edge/extensions-chromium/publish/api/addons-api-reference#check-the-status-of-a-package-upload

  core.info('Wait until package validated.')
  url = `https://api.addons.microsoftedge.microsoft.com/v1/products/${productId}/submissions/draft/package/operations/${operationId}`
  let status: string
  while (true) {
    response = await axios(url, { headers: { Authorization: `Bearer ${token}` } })
    status = response.data.status

    if (status !== 'InProgress') {
      break
    }

    core.info('Validation in progress. Wait 10 seconds.')
    await new Promise(res => setTimeout(res, 10000))
  }

  if (status === 'Succeeded') {
    core.info('Package validated.')
    return
  }

  // Validation failed.
  core.setFailed('Validation failed: ' + response.data.errorCode)
  core.setFailed(response.data.message)
  response.data.errors.forEach((e: unknown) => core.setFailed(JSON.stringify(e)))
}

async function sendSubmissionRequest(productId: string, token: string) {
  core.info('Start to send submission request.')
  // https://docs.microsoft.com/en-us/microsoft-edge/extensions-chromium/publish/api/using-addons-api#publishing-the-submission
  // https://docs.microsoft.com/en-us/microsoft-edge/extensions-chromium/publish/api/addons-api-reference#publish-the-product-draft-submission
  let url = `https://api.addons.microsoftedge.microsoft.com/v1/products/${productId}/submissions`
  let response = await axios.post(url, {}, { headers: { Authorization: `Bearer ${token}` } })
  const operationId = response.headers.location
  core.info('Submission request sent.')

  core.info('Start to check if submission request is accepted.')
  core.debug('Operation ID: ' + operationId)
  // https://docs.microsoft.com/en-us/microsoft-edge/extensions-chromium/publish/api/addons-api-reference#check-the-publishing-status
  url = `https://api.addons.microsoftedge.microsoft.com/v1/products/${productId}/submissions/operations/${operationId}`
  response = await axios(url, { headers: { Authorization: `Bearer ${token}` } })
  const status = response.data.Status

  if (status === 'Succeeded') {
    // https://docs.microsoft.com/en-us/microsoft-edge/extensions-chromium/publish/api/addons-api-reference#response-when-the-publish-call-succeeds
    core.info('Submission request accepted.')
    return
  }

  // Failed
  core.setFailed('Submission request not accepted.')
  const errorCode = response.data.errorCode

  if (errorCode === undefined || errorCode === null) {
    // https://docs.microsoft.com/en-us/microsoft-edge/extensions-chromium/publish/api/addons-api-reference#response-when-the-publish-call-fails-with-an-irrecoverable-failure
    // https://docs.microsoft.com/en-us/microsoft-edge/extensions-chromium/publish/api/addons-api-reference#response-when-the-publish-call-fails-with-an-unexpected-failure
    core.setFailed(response.data.message)
    return
  }

  switch (errorCode) {
    case 'SubmissionValidationError':
      // https://docs.microsoft.com/en-us/microsoft-edge/extensions-chromium/publish/api/addons-api-reference#response-when-there-are-validation-errors-in-submission
      core.setFailed(response.data.message)
      // TODO not sure if errors is list of string
      response.data.message.errors.forEach((e: unknown) => core.setFailed(JSON.stringify(e)))
      return

    case 'ModuleStateUnPublishable':
      // https://docs.microsoft.com/en-us/microsoft-edge/extensions-chromium/publish/api/addons-api-reference#response-where-any-of-the-modules-are-invalid
      core.setFailed(response.data.message)
      // TODO not sure if the errors is of length 1
      core.setFailed(JSON.stringify(response.data.errors))
      return

    case 'UnpublishInProgress':
    case 'InProgressSubmission':
    case 'NoModulesUpdated':
    case 'CreateNotAllowed':
      // https://docs.microsoft.com/en-us/microsoft-edge/extensions-chromium/publish/api/addons-api-reference#response-when-there-is-an-ongoing-unpublished-submission-for-the-same-product
      // https://docs.microsoft.com/en-us/microsoft-edge/extensions-chromium/publish/api/addons-api-reference#response-when-there-is-an-in-review-submission-for-the-same-product
      // https://docs.microsoft.com/en-us/microsoft-edge/extensions-chromium/publish/api/addons-api-reference#response-when-there-is-nothing-new-to-be-published
      // https://docs.microsoft.com/en-us/microsoft-edge/extensions-chromium/publish/api/addons-api-reference#response-when-a-new-product-is-published
      core.setFailed(response.data.message)
      return

    default:
      core.warning('Get unexpected error code: ' + errorCode)
      core.debug(JSON.stringify(response.data))
      core.setFailed(response.data.message)
      return
  }
}

async function run(productId: string, zipPath: string, clientId: string, clientSecret: string, accessUrl: string): Promise<void> {
  core.info('Start to publish edge addon.')

  const token = await getAccessToken(clientId, clientSecret, accessUrl)
  await uploadPackage(productId, zipPath, token)
  await sendSubmissionRequest(productId, token)

  core.info('Addon published.')
}

function handleError(error: unknown): void {
  // HTTP error
  if (error instanceof AxiosError) {
    if (error.response) {
      // Got response from Firefox API server with status code 4XX or 5XX
      core.setFailed('Firefox API server responses with error code: ' + error.response.status)
      core.setFailed(error.response.data)
    }
    core.setFailed(error.message)
    return
  }

  // Unknown error
  if (error instanceof Error) {
    core.setFailed('Unknown error occurred.')
    core.setFailed(error)
    return
  }

  // Unknown error type
  core.setFailed('Unknown error occurred.')
}

async function main() {
  const productId = core.getInput('product-id', { required: true })
  const zipPath = core.getInput('zip-path', { required: true })
  const clientId = core.getInput('client-id', { required: true })
  const clientSecret = core.getInput('client-secret', { required: true })
  const accessUrl = core.getInput('access-url', { required: true })

  core.debug('Using product ID: ' + productId)
  core.debug('Using zip file path: ' + zipPath)
  core.debug('Using client id: ' + clientId)
  core.debug('Using client secret: ' + clientSecret)
  core.debug('Using access url: ' + accessUrl)

  try {
    await run(productId, zipPath, clientId, clientSecret, accessUrl)
  } catch (e: unknown) {
    handleError(e)
  }
}

main()
