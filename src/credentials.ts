import * as vscode from 'vscode'

const TOKEN_KEY = 'gitpaste.github.personalAccessToken'
const GITHUB_SCOPES = ['repo']
const AUTHENTICATION_METHOD_SETTING = 'github.authenticationMethod'

type AuthenticationMethod = 'github' | 'pat'

export class Credentials {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async getToken(interactive: boolean): Promise<string> {
    const personalToken = await this.secrets.get(TOKEN_KEY)
    if (personalToken) return personalToken

    if (this.authenticationMethod === 'pat') {
      if (!interactive) {
        throw new Error('The configured personal access token is unavailable.')
      }
      const promptedToken = await this.promptForPersonalToken()
      if (!promptedToken) throw new vscode.CancellationError()
      return promptedToken
    }

    const existing = await vscode.authentication.getSession(
      'github',
      GITHUB_SCOPES,
      { createIfNone: false }
    )
    if (existing) return existing.accessToken
    if (!interactive) {
      throw new Error('GitHub authentication is required.')
    }

    const session = await vscode.authentication.getSession(
      'github',
      GITHUB_SCOPES,
      { createIfNone: true }
    )
    return session.accessToken
  }

  async signInWithGitHub(): Promise<string> {
    await this.secrets.delete(TOKEN_KEY)
    const session = await vscode.authentication.getSession(
      'github',
      GITHUB_SCOPES,
      { createIfNone: true }
    )
    await this.setAuthenticationMethod('github')
    return session.accessToken
  }

  async promptForPersonalToken(): Promise<string | undefined> {
    const token = await vscode.window.showInputBox({
      title: 'GitPaste: GitHub personal access token',
      prompt:
        'Use a fine-grained token with Contents read and write access to the image repository.',
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) =>
        value.trim() ? undefined : 'A token is required.'
    })
    if (!token) return undefined
    await this.secrets.store(TOKEN_KEY, token.trim())
    await this.setAuthenticationMethod('pat')
    return token.trim()
  }

  async clearPersonalToken(): Promise<void> {
    await this.secrets.delete(TOKEN_KEY)
    await this.setAuthenticationMethod('github')
  }

  private get authenticationMethod(): AuthenticationMethod {
    return vscode.workspace
      .getConfiguration('gitpaste')
      .get<AuthenticationMethod>(AUTHENTICATION_METHOD_SETTING, 'github')
  }

  private async setAuthenticationMethod(
    method: AuthenticationMethod
  ): Promise<void> {
    await vscode.workspace
      .getConfiguration('gitpaste')
      .update(
        AUTHENTICATION_METHOD_SETTING,
        method,
        vscode.ConfigurationTarget.Global
      )
  }
}
