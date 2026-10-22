import * as vscode from 'vscode'
import { errorMessage } from './util'

const TOKEN_KEY = 'gitpaste.github.personalAccessToken'
const GITHUB_SCOPES = ['repo']
const AUTHENTICATION_METHOD_SETTING = 'github.authenticationMethod'

type AuthenticationMethod = 'github' | 'pat'

export class Credentials {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async getToken(
    interactive: boolean,
    verify?: (token: string) => Promise<void>,
  ): Promise<string> {
    const personalToken = await this.secrets.get(TOKEN_KEY)
    if (personalToken) return personalToken

    if (this.authenticationMethod === 'pat') {
      if (!interactive) {
        throw new Error('The configured personal access token is unavailable.')
      }
      const promptedToken = await this.promptForPersonalTokenValue()
      if (!promptedToken) throw new vscode.CancellationError()
      // Verify before persisting so an invalid token is never written to
      // SecretStorage. Mirrors the setToken/configure flows.
      if (verify) {
        try {
          await verify(promptedToken)
        } catch (error) {
          void vscode.window.showErrorMessage(
            `GitPaste: the personal access token is invalid: ${errorMessage(
              error,
            )}`,
          )
          throw new vscode.CancellationError()
        }
      }
      await this.savePersonalToken(promptedToken)
      return promptedToken
    }

    const existing = await vscode.authentication.getSession(
      'github',
      GITHUB_SCOPES,
      { createIfNone: false },
    )
    if (existing) return existing.accessToken
    if (!interactive) {
      throw new Error('GitHub authentication is required.')
    }

    const session = await vscode.authentication.getSession(
      'github',
      GITHUB_SCOPES,
      { createIfNone: true },
    )
    return session.accessToken
  }

  async signInWithGitHub(): Promise<string> {
    await this.secrets.delete(TOKEN_KEY)
    const session = await vscode.authentication.getSession(
      'github',
      GITHUB_SCOPES,
      { createIfNone: true },
    )
    await this.setAuthenticationMethod('github')
    return session.accessToken
  }

  /** Prompts for a personal access token without persisting it. */
  async promptForPersonalTokenValue(): Promise<string | undefined> {
    const token = await vscode.window.showInputBox({
      title: 'GitPaste: GitHub personal access token',
      prompt:
        'Use a fine-grained token with Contents read and write access to the image repository.',
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) =>
        value.trim() ? undefined : 'A token is required.',
    })
    return token?.trim() || undefined
  }

  /** Persists a previously verified personal access token. */
  async savePersonalToken(token: string): Promise<void> {
    await this.secrets.store(TOKEN_KEY, token.trim())
    await this.setAuthenticationMethod('pat')
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
    method: AuthenticationMethod,
  ): Promise<void> {
    await vscode.workspace
      .getConfiguration('gitpaste')
      .update(
        AUTHENTICATION_METHOD_SETTING,
        method,
        vscode.ConfigurationTarget.Global,
      )
  }
}
