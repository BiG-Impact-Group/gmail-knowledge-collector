import type { Provider } from './provider'

// Shape a connector must implement to integrate with the OAuth + collection pipeline.
// Currently only 'google' is implemented (google-oauth-initiate, google-oauth-callback, gmail-collector).
// Week-2 target: Google Drive. Week-3 target: Slack.
export interface ConnectorConfig {
  provider: Provider
  initiateUrl: string
  callbackPath: string
  scopes: string[]
}
