import { basename, relative } from 'path'
import * as vscode from 'vscode'
import { GitExtension } from './git'


type LogData = {
    type: string,
    time: number,
    filePath: string | null,
    workspaceName: string | null,
    workspacePath: string | null,
    gitBranch: string | null,
}

type WorkspaceStat = {
    workspaceName: string | null,
    workspacePath: string | null,
    totalTime: number,
    branches: BranchStat[],
}

type BranchStat = {
    branchName: string,
    totalTime: number,
    files: FileStat[],
}

type FileStat = {
    fileName: string,
    totalTime: number,
    relativePath: string,
}

function getCurrentGitBranch(workspace: vscode.WorkspaceFolder): string | null {
    try {
        const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git')!
        const git = gitExtension.exports.getAPI(1)
        const repository = git.getRepository(workspace.uri)
        const branch = repository?.state?.HEAD?.name || null
        return branch
    } catch (e) {
        if ((e as Error).message !== "Error: Extension 'vscode.git' not found.") {
            if (process.env.NODE_ENV !== 'production') {
                console.error(e)
            }
        }
        throw e
    }
}


let lastLoggedTime = 0
const logInterval = 500
const logs: LogData[] = []


async function logActivity(logs: LogData[], type: string, currentDocument: vscode.TextDocument | null = null) {
    const now = new Date()
    const document = currentDocument || vscode.window.activeTextEditor?.document
    const workspace = (document && vscode.workspace.getWorkspaceFolder(document.uri)) || null
    if (!workspace) { return }

    try {
        var gitBranch = getCurrentGitBranch(workspace)
    } catch (e) {
        return
    }

    logs.push({
        type,
        time: now.getTime(),
        filePath: document?.fileName || null,
        workspaceName:
            workspace?.name ||
            vscode.workspace.name ||
            null,
        workspacePath:
            workspace?.uri.fsPath ||
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ||
            null,
        gitBranch,
    })
}


function analyzeLogs(logs: LogData[], stats: WorkspaceStat[], cleanedLogs: LogData[]) {
    let lastLogData: LogData | null = null

    logs.splice(0, logs.length).forEach((log, index, allLogs) => {
        if (cleanedLogs.length === 0) {
            cleanedLogs.push(log)
        } else {
            const lastCleanLog = cleanedLogs[cleanedLogs.length - 1]

            if (lastCleanLog.workspacePath !== log.workspacePath ||
                lastCleanLog.filePath !== log.filePath ||
                log.time - lastCleanLog.time >= logInterval
            ) {
                cleanedLogs.push(log)
            }
        }

        if (index === 0) { return }

        if (lastLogData === null) {
            lastLogData = log
            return
        }

        if (
            log.workspaceName !== lastLogData.workspaceName ||
            log.filePath !== lastLogData.filePath ||
            index === allLogs.length - 1
        ) {
            const time = allLogs[index - 1].time - lastLogData.time

            // Add time to workspace
            let workspace = stats.find(workspace =>
                workspace.workspacePath === lastLogData!.workspacePath &&
                workspace.workspaceName === lastLogData!.workspaceName
            )
            if (!workspace) {
                stats.push({
                    workspaceName: lastLogData.workspaceName,
                    workspacePath: lastLogData.workspacePath,
                    totalTime: 0,
                    branches: [],
                })
                workspace = stats[stats.length - 1]
            }
            workspace.totalTime += time

            // Add time to branch
            const branchName = lastLogData.gitBranch || '[no-branch]'
            let branch = workspace.branches.find(branch => branch.branchName === branchName)
            if (!branch) {
                workspace.branches.push({
                    branchName,
                    totalTime: 0,
                    files: [],
                })
                branch = workspace.branches[workspace.branches.length - 1]
            }
            branch.totalTime += time

            // Add time to file
            if (lastLogData.filePath) {
                const relativePath = relative(workspace.workspacePath || '', lastLogData.filePath)
                const fileName = basename(lastLogData.filePath)
                let file = branch.files.find(file => file.fileName === fileName)
                if (!file) {
                    branch.files.push({
                        fileName: fileName,
                        totalTime: 0,
                        relativePath
                    })
                    file = branch.files[branch.files.length - 1]
                }
                file.totalTime += time
            }

            lastLogData = log
        }
    })
}

const onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>()

export function activate(context: vscode.ExtensionContext) {
    function handler(type: string) {
        return (event: any) => {
            const document =
                event?.document ||
                event?.textEditor?.document ||
                null
            if (document?.uri.scheme === 'typelogs') { return }

            const now = new Date()
            if (now.getTime() - lastLoggedTime >= logInterval) {
                logActivity(logs, type, document)
            }
        }
    }

    for (const namespace of [vscode.workspace, vscode.window]) {
        for (const event of Object.keys(namespace)) {
            if (!event.startsWith('on')) { continue }
            const typedEvent = event as keyof typeof namespace

            try {
                context.subscriptions.push((namespace[typedEvent] as CallableFunction)(handler(event)))
                console.log(`Subscribed to ${event} event`)
            }
            catch (e) {
                if (process.env.NODE_ENV !== 'production') { console.error(e) }
            }
        }
    }

    setInterval(async () => {
        const stats = context.globalState.get('stats', [])
        const cleanedLogs = context.globalState.get('cleanedLogs', [])
        analyzeLogs(logs, stats, cleanedLogs)
        context.globalState.update('stats', stats)
        context.globalState.update('cleanedLogs', cleanedLogs)
    }, 5000)

    vscode.workspace.registerTextDocumentContentProvider('typelogs', {
        provideTextDocumentContent(uri: vscode.Uri): string {
            return JSON.stringify({
                stats: context.globalState.get('stats', []),
                cleanedLen: context.globalState.get('cleanedLogs', []).length,
                len: logs.length,
                now: new Date().toISOString()
            } as object, null, 2)
        },
        onDidChange: onDidChangeEmitter.event
    })

    context.subscriptions.push(vscode.commands.registerCommand('work-time-tracker.showLogs', () => {
        vscode.commands.executeCommand('vscode.open', vscode.Uri.parse('typelogs://debug'))
    }))

    // Open typelogs if not opened yet
    const openedEditors = vscode.window.visibleTextEditors
    const openedTypelogs = openedEditors.find(editor => editor.document.uri.scheme === 'typelogs')
    if (!openedTypelogs) {
        // open to the side
        vscode.commands.executeCommand('vscode.open', vscode.Uri.parse('typelogs://debug'), vscode.ViewColumn.Beside)
    }
    setInterval(() => {
        // Refresh typelogs
        onDidChangeEmitter.fire(vscode.Uri.parse('typelogs://debug'))
    }, 100)
}

export function deactivate() { }
