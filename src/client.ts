/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'coc.nvim';

import {OpenOutputChannel, ProjectLoadingFinish, ProjectLoadingStart, SuggestStrictMode, SuggestStrictModeParams} from './common/notifications';
import {GetCompleteItems, GetComponentsWithTemplateFile, GetHoverInfo, GetTcbRequest, GetTemplateLocationForComponent, IsInAngularProject} from './common/requests';
import {provideCompletionItem} from './middleware/provideCompletionItem';
import {resolve, Version} from './common/resolver';

import {isInsideComponentDecorator, isInsideInlineTemplateRegion, isInsideStringLiteral} from './embedded_support';
import {code2ProtocolConverter, protocol2CodeConverter} from './common/utils';
import { DocumentUri } from 'vscode-languageserver-protocol';

interface GetTcbResponse {
  uri: vscode.Uri;
  content: string;
  selections: vscode.Range[];
}

type GetComponentsForOpenExternalTemplateResponse = Array<{uri: DocumentUri; range: vscode.Range;}>;

export class AngularLanguageClient implements vscode.Disposable {
  private client: vscode.LanguageClient|null = null;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly outputChannel: vscode.OutputChannel;
  private readonly clientOptions: vscode.LanguageClientOptions;
  private readonly name = 'Angular Language Service';
  private readonly virtualDocumentContents = new Map<string, string>();
  /** A map that indicates whether Angular could be found in the file's project. */
  private readonly fileToIsInAngularProjectMap = new Map<string, boolean>();

  constructor(private readonly context: vscode.ExtensionContext) {
    vscode.workspace.registerTextDocumentContentProvider('angular-embedded-content', {
      provideTextDocumentContent: uri => {
        return this.virtualDocumentContents.get(uri.toString());
      }
    });

    this.outputChannel = vscode.window.createOutputChannel(this.name);
    // Options to control the language client
    this.clientOptions = {
      // Register the server for Angular templates and TypeScript documents
      documentSelector: [
        // scheme: 'file' means listen to changes to files on disk only
        // other option is 'untitled', for buffer in the editor (like a new doc)
        {scheme: 'file', language: 'html'},
        {scheme: 'file', language: 'typescript'},
      ],
      synchronize: {
        fileEvents: [
          // Notify the server about file changes to tsconfig.json contained in the workspace
          vscode.workspace.createFileSystemWatcher('**/tsconfig.json'),
        ]
      },
      // Don't let our output console pop open
      revealOutputChannelOn: vscode.RevealOutputChannelOn.Never,
      outputChannel: this.outputChannel,
      // middleware
      middleware: {
         prepareRename: async (
            document: vscode.TextDocument, position: vscode.Position,
            token: vscode.CancellationToken, next: vscode.PrepareRenameSignature) => {
          // We are able to provide renames for many types of string literals: template strings,
          // pipe names, and hopefully in the future selectors and input/output aliases. Because
          // TypeScript isn't able to provide renames for these, we can more or less
          // guarantee that the Angular Language service will be called for the rename as the
          // fallback. We specifically do not provide renames outside of string literals
          // because we cannot ensure our extension is prioritized for renames in TS files (see
          // https://github.com/microsoft/vscode/issues/115354) we disable renaming completely so we
          // can provide consistent expectations.
          if (await this.isInAngularProject(document) &&
              isInsideStringLiteral(document, position)) {
            return next(document, position, token);
          }
        },
        provideDefinition: async (
            document: vscode.TextDocument, position: vscode.Position,
            token: vscode.CancellationToken, next: vscode.ProvideDefinitionSignature) => {
          if (await this.isInAngularProject(document) &&
              isInsideComponentDecorator(document, position)) {
            return next(document, position, token);
          }
        },
        provideTypeDefinition: async (
            document: vscode.TextDocument, position: vscode.Position,
            token: vscode.CancellationToken, next) => {
          if (await this.isInAngularProject(document) &&
              isInsideInlineTemplateRegion(document, position)) {
            return next(document, position, token);
          }
        },
        provideHover: async (
            document: vscode.TextDocument, position: vscode.Position,
            token: vscode.CancellationToken, next: vscode.ProvideHoverSignature) => {
          if (!(await this.isInAngularProject(document)) ||
              !isInsideInlineTemplateRegion(document, position)) {
            return;
          }
          const angularResultsPromise = next(document, position, token);

          // Include results for inline HTML via virtual document and native html providers.
          if (document.languageId === 'typescript') {
            const vDocUri = this.createVirtualHtmlDoc(document);
            const htmlProviderResultsPromise =  await this.client.sendRequest(
              GetHoverInfo,
              {
                textDocument: {uri: vDocUri.toString()},
                position
              },
              token
            );

            const [angularResults, htmlProviderResults] =
                await Promise.all([angularResultsPromise, htmlProviderResultsPromise]);
            return angularResults ?? htmlProviderResults?.[0];
          }

          return angularResultsPromise;
        },
        provideSignatureHelp: async (
            document: vscode.TextDocument, position: vscode.Position,
            context: vscode.SignatureHelpContext, token: vscode.CancellationToken,
            next: vscode.ProvideSignatureHelpSignature) => {
          if (await this.isInAngularProject(document) &&
              isInsideInlineTemplateRegion(document, position)) {
            return next(document, position, context, token);
          }
        },
        provideCompletionItem: async (
          document: vscode.TextDocument, position: vscode.Position,
          context: vscode.CompletionContext, token: vscode.CancellationToken,
          next: vscode.ProvideCompletionItemsSignature) => {
          // If not in inline template, do not perform request forwarding
          if (!(await this.isInAngularProject(document)) ||
              !isInsideInlineTemplateRegion(document, position)) {
            return;
          }
          const angularCompletionsPromise = next(document, position, context, token) as
              Promise<vscode.CompletionItem[]|null|undefined>;

          // Include results for inline HTML via virtual document and native html providers.
          if (document.languageId === 'typescript') {
            const vDocUri = this.createVirtualHtmlDoc(document);
            // This will not include angular stuff because the vDoc is not associated with an
            // angular component
            const htmlProviderCompletionsPromise =  await this.client.sendRequest(
              GetCompleteItems,
              {
                textDocument: {uri: vDocUri.toString()},
                position,
                context: {
                  triggerCharacter: context.triggerCharacter
                }
              },
              token
            );
            const [angularCompletions, htmlProviderCompletions] =
                await Promise.all([angularCompletionsPromise, htmlProviderCompletionsPromise]);
            return [...(angularCompletions ?? []), ...(htmlProviderCompletions?.items ?? [])];
          }

          return angularCompletionsPromise.then(items => provideCompletionItem(document, position, items ?? []));
        }
      }
    };
  }

   private async isInAngularProject(doc: vscode.TextDocument): Promise<boolean> {
     if (this.client === null) {
       return false;
     }
     const uri = doc.uri.toString();
     if (this.fileToIsInAngularProjectMap.has(uri)) {
       return this.fileToIsInAngularProjectMap.get(uri)!;
     }

     try {
       const response = await this.client.sendRequest(IsInAngularProject, {
         textDocument: code2ProtocolConverter.asTextDocumentIdentifier(doc),
       });
       if (response === null) {
         // If the response indicates the answer can't be determined at the moment, return `false`
         // but do not cache the result so we can try to get the real answer on follow-up requests.
         return false;
       }
       this.fileToIsInAngularProjectMap.set(uri, response);
       return response;
     } catch {
       return false;
     }
  }

  private createVirtualHtmlDoc(document: vscode.TextDocument): vscode.Uri {
    const originalUri = document.uri.toString();
    const vdocUri = vscode.Uri.file(encodeURIComponent(originalUri) + '.html')
                        .with({scheme: 'angular-embedded-content', authority: 'html'});
    this.virtualDocumentContents.set(vdocUri.toString(), document.getText());
    return vdocUri;
  }

  /**
   * Spin up the language server in a separate process and establish a connection.
   */
  async start(): Promise<void> {
    if (this.client !== null) {
      throw new Error(`An existing client is running. Call stop() first.`);
    }

    // If the extension is launched in debug mode then the debug server options are used
    // Otherwise the run options are used
    const serverOptions: vscode.ServerOptions = {
      run: getServerOptions(this.context, false /* debug */),
      debug: getServerOptions(this.context, true /* debug */),
    };

    // Create the language client and start the client.
    const forceDebug = process.env['NG_DEBUG'] === 'true';
    this.client = new vscode.LanguageClient(
        // This is the ID for Angular-specific configurations, like "angular.log".
        // See contributes.configuration in package.json.
        'angular',
        this.name,
        serverOptions,
        this.clientOptions,
        forceDebug,
    );
    this.disposables.push(this.client.start());
    await this.client.onReady();
    // Must wait for the client to be ready before registering notification
    // handlers.
    this.disposables.push(registerNotificationHandlers(this.client));
  }

  /**
   * Kill the language client and perform some clean ups.
   */
  async stop(): Promise<void> {
    if (this.client === null) {
      return;
    }
    await this.client.stop();
    this.outputChannel.clear();
    this.dispose();
    this.client = null;
    this.fileToIsInAngularProjectMap.clear();
    this.virtualDocumentContents.clear();
  }

   /**
   * Requests a template typecheck block at the current cursor location in the
   * specified editor.
   */
  async getTcbUnderCursor(): Promise<GetTcbResponse|undefined> {
    if (this.client === null) {
      return undefined;
    }
    const doc = await vscode.workspace.document
    if (!doc) {
      return
    }
    const cursor = await vscode.window.getCursorPosition()
    if (!cursor) {
      return
    }
    const textDocument = doc.textDocument
    const c2pConverter = code2ProtocolConverter;
    // Craft a request by converting vscode params to LSP. The corresponding
    // response is in LSP.
    const response = await this.client.sendRequest(GetTcbRequest, {
      textDocument: c2pConverter.asTextDocumentIdentifier(textDocument),
      position: cursor,
    });
    if (response === null) {
      return undefined;
    }
    const p2cConverter = protocol2CodeConverter;
    // Convert the response from LSP back to vscode.
    return {
      uri: p2cConverter.asUri(response.uri),
      content: response.content,
      selections: response.selections || []
    };
  }

  get initializeResult(): vscode.InitializeResult|undefined {
    return this.client?.initializeResult;
  }

  async getComponentsForOpenExternalTemplate(textDocument: vscode.TextDocument):
      Promise<GetComponentsForOpenExternalTemplateResponse|undefined> {
    if (this.client === null) {
      return undefined;
    }

    const response = await this.client.sendRequest(GetComponentsWithTemplateFile, {
      textDocument: code2ProtocolConverter.asTextDocumentIdentifier(textDocument),
    });
    if (response === undefined || response === null) {
      return undefined;
    }

    return response;
  }

  async getTemplateLocationForComponent(document: vscode.Document):
      Promise<vscode.Location|null> {
    if (this.client === null) {
      return null;
    }
    const position = await vscode.window.getCursorPosition()
    const c2pConverter = code2ProtocolConverter;
    // Craft a request by converting vscode params to LSP. The corresponding
    // response is in LSP.
    const response = await this.client.sendRequest(GetTemplateLocationForComponent, {
      textDocument: c2pConverter.asTextDocumentIdentifier(document.textDocument),
      position: c2pConverter.asPosition(position),
    });
    if (response === null) {
      return null;
    }
    const p2cConverter = protocol2CodeConverter;
    return vscode.Location.create(
        p2cConverter.asUri(response.uri).toString(), p2cConverter.asRange(response.range));
  }

  dispose() {
    for (let d = this.disposables.pop(); d !== undefined; d = this.disposables.pop()) {
      d.dispose();
    }
  }
}

function registerNotificationHandlers(client: vscode.LanguageClient) {
  let task: {resolve: () => void}|undefined;
  client.onNotification(ProjectLoadingStart, () => {
    const statusBar = vscode.window.createStatusBarItem(0, { progress: true })
    statusBar.text = 'Angular'
    statusBar.show()
    task = {
      resolve: () => {
        statusBar.isProgress = false
        statusBar.hide()
        statusBar.dispose()
      }
    }
    client.onNotification(ProjectLoadingFinish, () => {
      task.resolve();
      task = undefined;
    });
  });
  const disposable1 = vscode.Disposable.create(() => {
    if (task) {
      task.resolve()
      task = undefined
    }
  })
  client.onNotification(SuggestStrictMode, async (params: SuggestStrictModeParams) => {
    const config = vscode.workspace.getConfiguration();
    if (config.get('angular.enable-strict-mode-prompt') === false) {
      return;
    }
    const openTsConfig = 'Open tsconfig.json';
    const doNotPromptAgain = 'Do not show this again';
    // Markdown is not generally supported in `showInformationMessage()`,
    // but links are supported. See
    // https://github.com/microsoft/vscode/issues/20595#issuecomment-281099832
    const selection = await vscode.window.showInformationMessage(
      'Some language features are not available. To access all features, enable ' +
      '[strictTemplates](https://angular.io/guide/angular-compiler-options#stricttemplates) in ' +
      '[angularCompilerOptions](https://angular.io/guide/angular-compiler-options).',
      openTsConfig,
      doNotPromptAgain,
    );
    if (selection === openTsConfig) {
      await vscode.workspace.openResource(params.configFilePath);
    } else if (selection === doNotPromptAgain) {
      config.update(
        'angular.enable-strict-mode-prompt', false, (vscode as any).ConfigurationTarget?.Global);
    }
  });

  client.onNotification(OpenOutputChannel, () => {
    client.outputChannel.show();
  })

  return disposable1;
}

/**
 * Return the paths for the module that corresponds to the specified `configValue`,
 * and use the specified `bundled` as fallback if none is provided.
 * @param configName
 * @param bundled
 */
function getProbeLocations(bundled: string): string[] {
  const locations = [];
  // Prioritize the bundled version
  locations.push(bundled);
  // Look in workspaces currently open
  const workspaceFolders = vscode.workspace.workspaceFolders || [];
  for (const folder of workspaceFolders) {
    locations.push(vscode.Uri.parse(folder.uri).fsPath);
  }
  return locations;
}

/**
 * Construct the arguments that's used to spawn the server process.
 * @param ctx vscode extension context
 */
function constructArgs(ctx: vscode.ExtensionContext, viewEngine: boolean): string[] {
  const config = vscode.workspace.getConfiguration();
  const args: string[] = ['--logToConsole'];

  const ngLog: string = config.get('angular.log', 'off');
  if (ngLog !== 'off') {
    // Log file does not yet exist on disk. It is up to the server to create the file.
    const logFile = path.join(ctx.storagePath, 'nglangsvc.log');
    args.push('--logFile', logFile);
    args.push('--logVerbosity', ngLog);
  }

  const ngProbeLocations = getProbeLocations(ctx.extensionPath);
  if (viewEngine) {
    args.push('--viewEngine');
    args.push('--ngProbeLocations', [
      path.join(ctx.extensionPath, 'v12_language_service'),
      ...ngProbeLocations,
    ].join(','));
  } else {
    args.push('--ngProbeLocations', ngProbeLocations.join(','));
  }

  const includeAutomaticOptionalChainCompletions =
      config.get<boolean>('angular.suggest.includeAutomaticOptionalChainCompletions');
  if (includeAutomaticOptionalChainCompletions) {
    args.push('--includeAutomaticOptionalChainCompletions');
  }

  const includeCompletionsWithSnippetText =
      config.get<boolean>('angular.suggest.includeCompletionsWithSnippetText');
  if (includeCompletionsWithSnippetText) {
    args.push('--includeCompletionsWithSnippetText');
  }

  const tsdk: string|null = config.get('typescript.tsdk', null);
  const tsProbeLocations = [tsdk, ...getProbeLocations(ctx.extensionPath)];
  args.push('--tsProbeLocations', tsProbeLocations.join(','));

  return args;
}

function getServerOptions(ctx: vscode.ExtensionContext, debug: boolean): vscode.NodeModule {
  // Environment variables for server process
  const prodEnv = {};
  const devEnv = {
    ...prodEnv,
    NG_DEBUG: true,
  };

  // Because the configuration is typed as "boolean" in package.json, vscode
  // will return false even when the value is not set. If value is false, then
  // we need to check if all projects support Ivy language service.
  const config = vscode.workspace.getConfiguration();
  let viewEngine: boolean = config.get('angular.view-engine') || !allProjectsSupportIvy();
  if (viewEngine && !allProjectsSupportVE()) {
    viewEngine = false;
    if (config.get('angular.view-engine')) {
      vscode.window.showErrorMessage(
          `The legacy View Engine option is enabled but the workspace contains a version 13 Angular project.` +
              ` Legacy View Engine will be disabled since support for it was dropped in v13.`,
      );
    } else if (!allProjectsSupportIvy() && !allProjectsSupportVE()) {
      vscode.window.showErrorMessage(
          `The workspace contains a project that does not support legacy View Engine (Angular v13+) and a project that does not support the new current runtime (v8 and below).` +
          `The extension will not work for the legacy project in this workspace.`);
    }
  }

  // Node module for the language server
  const args = constructArgs(ctx, viewEngine);
  const prodBundle = ctx.asAbsolutePath(path.join('node_modules', '@angular', 'language-server'));
  const devBundle = ctx.asAbsolutePath(path.join('node_modules', '@angular', 'language-server'));
  // VS Code Insider launches extensions in debug mode by default but users
  // install prod bundle so we have to check whether dev bundle exists.
  const latestServerModule = debug && fs.existsSync(devBundle) ? devBundle : prodBundle;
  const v12ServerModule = ctx.asAbsolutePath(
      path.join('node_modules', 'v12_language_service', 'node_modules', '@angular', 'language-server'));
  const module = viewEngine ? v12ServerModule : latestServerModule;

  // Argv options for Node.js
  const prodExecArgv: string[] = [];
  const devExecArgv: string[] = [
    // do not lazily evaluate the code so all breakpoints are respected
    '--nolazy',
    // If debugging port is changed, update .vscode/launch.json as well
    '--inspect=6009',
  ];

  return {
    // VS Code Insider launches extensions in debug mode by default but users
    // install prod bundle so we have to check whether dev bundle exists.
    module,
    transport: vscode.TransportKind.ipc,
    args,
    options: {
      env: debug ? devEnv : prodEnv,
      execArgv: debug ? devExecArgv : prodExecArgv,
    },
  };
}

function allProjectsSupportIvy() {
  const workspaceFolders = vscode.workspace.workspaceFolders || [];
  for (const workspaceFolder of workspaceFolders) {
    const angularCore = resolve('@angular/core', vscode.Uri.parse(workspaceFolder.uri).fsPath);
    if (angularCore?.version.greaterThanOrEqual(new Version('9')) === false) {
      return false;
    }
  }
  return true;
}

function allProjectsSupportVE() {
  const workspaceFolders = vscode.workspace.workspaceFolders || [];
  for (const workspaceFolder of workspaceFolders) {
    const angularCore = resolve('@angular/core', vscode.Uri.parse(workspaceFolder.uri).fsPath);
    if (angularCore?.version.greaterThanOrEqual(new Version('13')) === true) {
      return false;
    }
  }
  return true;
}
