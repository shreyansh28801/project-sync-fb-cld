// Extension Entry Point: extension.ts
import * as vscode from 'vscode';
import * as path from 'path';
import { signOutUser, performGoogleOAuth, auth, db, collection, getDocs, setDoc, getDoc, doc, updateDoc, deleteDoc, serverTimestamp, onAuthStateChanged, onSnapshot } from './firebase';
import { timeStamp } from 'console';


let currentUser: any = null;
let activePanel: vscode.WebviewPanel | undefined = undefined;

interface Project {
  id: string;
  fileNames?: string[];
  timestamps?: { seconds: number; nanoseconds: number }; // Firestore timestamps
}

// Real-time sync watcher
let fsWatcher: vscode.FileSystemWatcher | undefined;
let isRealtimeSyncEnabled = false;

export function activate(context: vscode.ExtensionContext) {
  isRealtimeSyncEnabled = context.globalState.get('realtimeSyncEnabled', false);

  console.log('Firebase Project Sync extension is now active');

  // Create a sidebar view provider
  const provider = new FirebaseProjectSyncViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      FirebaseProjectSyncViewProvider.viewType,
      provider
    )
  );


  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('firebase-project-sync.signIn', async () => {
      performGoogleOAuth(context)
        .then(() => {
          console.log('uid : ', currentUser.uid);
          vscode.window.showInformationMessage('Signing Success with name and uid respectively : ', currentUser.displayName || currentUser.email, currentUser.uid);
        })
        .catch((error: any) => {
          vscode.window.showErrorMessage('Failed to sign in: ' + error.message);
        });
    }),

    vscode.commands.registerCommand('firebase-project-sync.saveProject', async () => {
      if (!currentUser) {
        vscode.window.showErrorMessage('Please sign in first');
        return;
      }
      saveNewProject();
    }),

    vscode.commands.registerCommand('firebase-project-sync.updateProject', async () => {
      if (!currentUser) {
        vscode.window.showErrorMessage('Please sign in first');
        return;
      }

      updateProject();
    }),

    vscode.commands.registerCommand('firebase-project-sync.listProjects', async () => {
      if (!currentUser) {
        vscode.window.showErrorMessage('Please sign in first');
        return;
      }
      showProjectList();
    }),

    vscode.commands.registerCommand('firebase-project-sync.deleteProject', async () => {
      if (!currentUser) {
        vscode.window.showErrorMessage('Please sign in first');
        return;
      }
      deleteProject();
    }),

    vscode.commands.registerCommand('firebase-project-sync.logout', () => {
      signOutUser();
    }),

    vscode.commands.registerCommand('firebase-sync.toggleRealtimeSync', () => {
      toggleRealtimeSync();
    })
  );

  // Setup auth state listener
  onAuthStateChanged(auth, (user) => {
    if (user) {
      currentUser = user;
      // provider.updateUser(user);
      provider.updateSignInStatus(true, user.displayName || user.email || '');
      vscode.window.showInformationMessage(`Signed in as ${user.displayName || user.email}`);
    } else {
      currentUser = null;
      // provider.updateUser(null);
      provider.updateSignInStatus(false, '');

      if (isRealtimeSyncEnabled) {
        toggleRealtimeSync(); // Disable real-time sync when logged out
      }
    }
  });

  // // Try to restore auth session from stored credentials
  // const storedCredentials = context.globalState.get('firebase-credentials');
  // if (storedCredentials) {
  //   try {
  //     const provider = new GoogleAuthProvider();
  //     signInWithCredential(auth, storedCredentials as OAuthCredential)
  //       .catch(() => {
  //         // Silently fail if stored credentials are invalid
  //         context.globalState.update('firebase-credentials', undefined);
  //       });
  //   } catch (error) {
  //     // Clear invalid credentials
  //     context.globalState.update('firebase-credentials', undefined);
  //   }
  // }
}



async function createUser(userId: string, email: string) {
  try {
    const userRef = doc(db, 'users', userId);
    const userSnap = await getDoc(userRef);

    if (userSnap.exists()) {
      console.log(`User "${userId}" already exists!`);
      return;
    }

    await setDoc(userRef, {
      email: email,
      createdAt: new Date()
    });
    vscode.window.showInformationMessage(`New User "${email}" saved successfully!`);
    console.log(`User "${email}" created successfully!`);
  } catch (error: any) {
    console.error(`Failed to create user: ${error.message}`);
  }
}

// Save new project
async function saveNewProject() {
  try {
    const projectName = vscode.workspace.name;
    if (!projectName) {
      vscode.window.showErrorMessage('Project name is required.');
      return;
    }

    // Generate project reference
    const projectRef = doc(db, 'users', currentUser.uid, 'projects', projectName);
    const projectSnap = await getDoc(projectRef);

    if (projectSnap.exists()) {
      vscode.window.showErrorMessage(`Project "${projectName}" already exists!`);
      return;
    }

    const files = await vscode.workspace.findFiles('**/*');
    const fileNames = files.map(file => file.fsPath);

    if (fileNames.length === 0) {
      vscode.window.showWarningMessage('No files found in the current workspace');
      return;
    }

    await setDoc(projectRef, {
      id: projectName,
      fileNames: fileNames,
      timestamp: serverTimestamp(),
    });

    vscode.window.showInformationMessage(`New Project "${projectName}" saved successfully!`);
  } catch (error: any) {
    const err = error as Error;
    vscode.window.showErrorMessage('Failed to save project: ' + err.message);
  }
}

// Update existing project
async function updateProject() {
  try {
    const projectId = vscode.workspace.name;
    if (!projectId) {
      vscode.window.showErrorMessage('No workspace is opened to update.');
      return;
    }

    const projectRef = doc(db, 'users', currentUser.uid, 'projects', projectId);
    const projectSnap = await getDoc(projectRef);

    if (!projectSnap.exists()) {
      vscode.window.showErrorMessage('Project does not exist!');
      return;
    }

    const files = await vscode.workspace.findFiles('**/*');
    const fileNames = files.map(file => file.fsPath);

    await updateDoc(projectRef, {
      fileNames,
      timestamps: serverTimestamp()
    });
    vscode.window.showInformationMessage(`Project "${projectId}" updated successfully`);
  } catch (error: any) {
    vscode.window.showErrorMessage(`Failed to update project: ${error.message}`);
  }
}

// Delete project
async function deleteProject() {
  try {
    const projectId = vscode.workspace.name;
    if (!projectId) {
      vscode.window.showErrorMessage('No workspace is opened to delete.');
      return;
    }
    const projectRef = doc(db, 'users', currentUser.uid, 'projects', projectId);
    const projectSnap = await getDoc(projectRef);

    if (!projectSnap.exists()) {
      vscode.window.showErrorMessage('Project does not exist!');
      return;
    }

    // Confirm before deleting
    const confirmDelete = await vscode.window.showWarningMessage(
      `Are you sure you want to delete project "${projectId}"?`,
      { modal: true }, 'Yes'
    );

    if (confirmDelete !== 'Yes') {
      vscode.window.showInformationMessage('Project deletion canceled.');
      return;
    }

    await deleteDoc(projectRef);

    vscode.window.showInformationMessage(`Project "${projectId}" deleted successfully!`);
  } catch (error: any) {
    vscode.window.showErrorMessage(`Failed to delete project: ${error.message}`);
  }
}

// Get all projects for current user
async function getProjects() {
  try {
    const projectsRef = collection(db, 'users', currentUser.uid, 'projects');
    const projectDocs = await getDocs(projectsRef);

    if (projectDocs.empty) {
      vscode.window.showInformationMessage('No projects found.');
      return [];
    }

    const projects: Project[] = projectDocs.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        fileNames: data.fileNames || [],
        timestamps: data.timestamps
      } as Project

    });

    return projects;
  } catch (error: any) {
    vscode.window.showErrorMessage(`Failed to fetch projects: ${error.message}`);
    return [];
  }
}

// Show project list in a webview
async function showProjectList() {
  try {
    const projects = await getProjects();

    if (!projects || projects.length === 0) {
      vscode.window.showInformationMessage('No projects found.');
      return;
    }

    if (activePanel) {
      activePanel.dispose();
    }

    activePanel = vscode.window.createWebviewPanel(
      'projectList',
      'Project List',
      vscode.ViewColumn.One,
      { enableScripts: true }
    );

    let projectListHtml = `
      <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; padding: 20px; }
            .project { margin-bottom: 20px; padding: 10px; border: 1px solid #ccc; border-radius: 4px; }
            .project-name { font-weight: bold; font-size: 16px; margin-bottom: 5px; }
            .file-list { margin-left: 20px; }
          </style>
        </head>
        <body>
          <h1>Your Projects</h1>
    `;

    projects.forEach(project => {
      const createdAt = project.timestamps
        ? new Date(project.timestamps.seconds * 1000).toLocaleString()
        : 'Unknown';

      projectListHtml += `
        <div class="project">
          <div class="project-name">${project.id || 'Unnamed Project'}</div>
          <div class="timestamp">Created: ${createdAt}</div>
          <div>Files:</div>
          <ul class="file-list">
      `;

      if (project.fileNames && project.fileNames.length > 0) {
        project.fileNames.forEach((file: string) => {
          projectListHtml += `<li>${file}</li>`;
        });
      } else {
        projectListHtml += `<li>No files found.</li>`;
      }

      projectListHtml += `
          </ul>
        </div>
      `;
    });

    projectListHtml += `
          </div>
        </body>
      </html>
    `;

    activePanel.webview.html = projectListHtml;


    activePanel.webview.html = projectListHtml;
  } catch (error: any) {
    vscode.window.showErrorMessage(`Failed to show project list: ${error.message}`);
  }
}

// Toggle real-time sync
function toggleRealtimeSync() {
  if (!currentUser) {
    vscode.window.showErrorMessage('Please sign in first');
    return;
  }

  if (!vscode.workspace.workspaceFolders) {
    vscode.window.showErrorMessage('No workspace is open');
    return;
  }

  isRealtimeSyncEnabled = !isRealtimeSyncEnabled;

  if (isRealtimeSyncEnabled) {
    // Start file system watcher
    setupRealtimeSync();
    vscode.window.showInformationMessage('Real-time sync enabled');
  } else {
    // Stop file system watcher
    if (fsWatcher) {
      fsWatcher.dispose();
      fsWatcher = undefined;
    }
    vscode.window.showInformationMessage('Real-time sync disabled');
  }
}

function setupRealtimeSync() {
  if (!currentUser || !vscode.workspace.name) return;

  const projectId = vscode.workspace.name;
  if (!projectId) {
    vscode.window.showErrorMessage('No workspace is opened to delete.');
    return;
  }

  // Create file system watcher for the workspace
  const fsWatcher = vscode.workspace.createFileSystemWatcher('**/*', false, true, false);//ignoting content file update events

  fsWatcher.onDidCreate(async (uri) => {
    console.log('File created:', uri.fsPath);
    try {
      // const relativePath = path.relative(vscode.workspace.workspaceFolders[0].uri.fsPath, uri.fsPath);
      const projectRef = doc(db, 'users', currentUser.uid, 'projects', projectId);
      const projectSnap = await getDoc(projectRef);
      if (projectSnap.exists()) {
        const data = projectSnap.data() as Project;
        const files = data.fileNames || [];
        if (!files.includes(uri.fsPath)) {
          files.push(uri.fsPath);
          await updateDoc(projectRef, {
            files: files,
            timeStamp: serverTimestamp()
          }).then(() => {
            console.log(`Added file ${uri.fsPath} to project`);
            vscode.window.showInformationMessage(`Added file ${uri.fsPath} to project`);
          }).catch((error) => {
            console.error(`Error updating file ${uri.fsPath} project: ${error}`);
          });
        }
      }
    } catch (error) {
      console.error('Error in file creation handler:', error);
    }
  });

  fsWatcher.onDidDelete(async (uri) => {
    console.log('File deleted:', uri.fsPath);
    try {
      // const relativePath = path.relative(vscode.workspace.workspaceFolders[0].uri.fsPath, uri.fsPath);
      const projectRef = doc(db, 'users', currentUser.uid, 'projects', projectId);
      const projectSnap = await getDoc(projectRef);
      if (projectSnap.exists()) {
        const data = projectSnap.data() as Project;
        const files = data.fileNames || [];
        if (files.includes(uri.fsPath)) {
          const updatedFiles = files.filter(file => file !== uri.fsPath);
          await updateDoc(projectRef, {
            files: updatedFiles,
            timeStamp: serverTimestamp()
          }).then(() => {
            vscode.window.showInformationMessage(`Deleted file ${uri.fsPath} from project`);
            console.log(`removed file ${uri.fsPath} to project`);
          }).catch((error) => {
            console.error(`Error removing file ${uri.fsPath} project: ${error}`);
          });
        }
      }
    } catch (error) {
      console.error('Error in file deletion handler:', error);
    }
  });
}


class FirebaseProjectSyncViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'firebase-project-sync.sidebar';
  private _view?: vscode.WebviewView;
  private _user: any = null;

  constructor(private readonly _extensionUri: vscode.Uri) { }

  // public updateUser(user: any) {
  //   this._user = user;
  //   if (this._view) {
  //     this._updateView();
  //   }
  // }

  public updateSignInStatus(isSignedIn: boolean, userDisplayName: string) {
    if (this._view) {
      this._view.webview.postMessage({ 
        command: 'updateSignInStatus', 
        isSignedIn, 
        userDisplayName 
      });
    }
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    console.log('resolveWebviewView', webviewView);
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };
    console.log('resolveWebviewView', this._view);
    this._updateView();
  }

  private _updateView() {
    if (!this._view) {
      return;
    }

    const isLoggedIn = !!this._user;

    // this._view.webview.html = `
    //   <!DOCTYPE html>
    //   <html lang="en">
    //   <head>
    //     <meta charset="UTF-8">
    //     <meta name="viewport" content="width=device-width, initial-scale=1.0">
    //     <title>Firebase Project Sync</title>
    //     <style>
    //       body {
    //         font-family: var(--vscode-font-family);
    //         padding: 20px;
    //         color: var(--vscode-foreground);
    //       }
    //       button {
    //         display: block;
    //         width: 100%;
    //         padding: 8px;
    //         margin: 10px 0;
    //         background-color: var(--vscode-button-background);
    //         color: var(--vscode-button-foreground);
    //         border: none;
    //         border-radius: 2px;
    //         cursor: pointer;
    //       }
    //       button:hover {
    //         background-color: var(--vscode-button-hoverBackground);
    //       }
    //       .user-info {
    //         margin-bottom: 20px;
    //         padding: 10px;
    //         border-radius: 4px;
    //         background-color: var(--vscode-editor-background);
    //       }
    //     </style>
    //   </head>
    //   <body>
    //     <h2>Firebase Project Sync</h2>
        
    //     ${isLoggedIn ? `
    //       <div class="user-info">
    //         <div>Signed in as:</div>
    //         <div><strong>${this._user.displayName || this._user.email}</strong></div>
    //       </div>
    //       <button id="saveBtn">Save New Project</button>
    //       <button id="listBtn">Project List</button>
    //       <button id="updateBtn">Update Project</button>
    //       <button id="deleteBtn">Delete Project</button>
    //       <button id="logoutBtn">Logout</button>
    //     ` : `
    //       <button id="loginBtn">Sign in with Google</button>
    //     `}

    //     <script>
    //       const vscode = acquireVsCodeApi();
          
    //       ${isLoggedIn ? `
    //         document.getElementById('saveBtn').addEventListener('click', () => {
    //           vscode.postMessage({ command: 'saveProject' });
    //         });
            
    //         document.getElementById('listBtn').addEventListener('click', () => {
    //           vscode.postMessage({ command: 'listProjects' });
    //         });
            
    //         document.getElementById('updateBtn').addEventListener('click', () => {
    //           vscode.postMessage({ command: 'updateProject' });
    //         });
            
    //         document.getElementById('deleteBtn').addEventListener('click', () => {
    //           vscode.postMessage({ command: 'deleteProject' });
    //         });
            
    //         document.getElementById('logoutBtn').addEventListener('click', () => {
    //           vscode.postMessage({ command: 'logout' });
    //         });
    //       ` : `
    //         document.getElementById('loginBtn').addEventListener('click', () => {
    //           vscode.postMessage({ command: 'signIn' });
    //         });
    //       `}
    //     </script>
    //   </body>
    //   </html>
    // `;

    this._view.webview.html = this._getHtmlForWebview(this._view.webview);

    // Handle messages from the webview
    this._view.webview.onDidReceiveMessage(message => {
      switch (message.command) {
        case 'signIn':
          vscode.commands.executeCommand('firebase-project-sync.signIn');
          break;
        case 'saveProject':
          vscode.commands.executeCommand('firebase-project-sync.saveProject');
          break;
        case 'listProjects':
          vscode.commands.executeCommand('firebase-project-sync.listProjects');
          break;
        case 'updateProject':
          vscode.commands.executeCommand('firebase-project-sync.updateProject');
          break;
        case 'deleteProject':
          vscode.commands.executeCommand('firebase-project-sync.deleteProject');
          break;
        case 'logout':
          vscode.commands.executeCommand('firebase-project-sync.logout');
          break;5
        case 'toggleRealtimeSync':
          vscode.commands.executeCommand('firebase-sync.toggleRealtimeSync');
          break;
      }
    });
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Firebase Sync</title>
        <style>
          body {
            padding: 20px;
            color: var(--vscode-foreground);
            font-family: var(--vscode-font-family);
          }
          button {
            display: block;
            width: 100%;
            padding: 8px;
            margin-bottom: 10px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 2px;
            cursor: pointer;
          }
          button:hover {
            background: var(--vscode-button-hoverBackground);
          }
          .user-info {
            margin-bottom: 20px;
            font-size: 14px;
          }
          .toggle-container {
            display: flex;
            align-items: center;
            margin-bottom: 10px;
          }
          .toggle-label {
            margin-left: 10px;
          }
          .project-list {
            margin-top: 20px;
          }
          .project-item {
            padding: 8px;
            margin-bottom: 5px;
            background: var(--vscode-list-hoverBackground);
            border-radius: 2px;
          }
        </style>
      </head>
      <body>
        <div id="app">
          <div id="signed-out" style="display: block;">
            <h3>Firebase Sync</h3>
            <p>Sign in to sync your projects</p>
            <button id="sign-in-btn">Sign in with Google</button>
          </div>
          
          <div id="signed-in" style="display: none;">
            <div class="user-info">
              Signed in as: <span id="user-display-name"></span>
            </div>
            
            <button id="save-project-btn">Save New Project</button>
            <button id="list-projects-btn">Project List</button>
            <button id="update-project-btn">Update Project</button>
            <button id="delete-project-btn">Delete Project</button>
            
            <div class="toggle-container">
              <button id="toggle-sync-btn">Toggle Real-time Sync</button>
              <span class="toggle-label" id="sync-status">Off</span>
            </div>
            
            <button id="sign-out-btn">Sign Out</button>
            
            <div class="project-list" id="project-list"></div>
          </div>
        </div>
        
        <script>
          (function() {
            const vscode = acquireVsCodeApi();
            let isRealtimeSyncEnabled = false;
            
            // Setup event listeners
            document.getElementById('sign-in-btn').addEventListener('click', () => {
              vscode.postMessage({ command: 'signIn' });
            });
            
            document.getElementById('save-project-btn').addEventListener('click', () => {
              vscode.postMessage({ command: 'saveProject' });
            });
            
            document.getElementById('list-projects-btn').addEventListener('click', () => {
              vscode.postMessage({ command: 'getProjects' });
            });
            
            document.getElementById('update-project-btn').addEventListener('click', () => {
              vscode.postMessage({ command: 'updateProject' });
            });
            
            document.getElementById('delete-project-btn').addEventListener('click', () => {
              vscode.postMessage({ command: 'deleteProject' });
            });
            
            document.getElementById('toggle-sync-btn').addEventListener('click', () => {
              vscode.postMessage({ command: 'toggleRealtimeSync' });
              isRealtimeSyncEnabled = !isRealtimeSyncEnabled;
              document.getElementById('sync-status').textContent = isRealtimeSyncEnabled ? 'On' : 'Off';
            });
            
            document.getElementById('sign-out-btn').addEventListener('click', () => {
              vscode.postMessage({ command: 'signOut' });
            });
            
            // Handle messages from the extension
            window.addEventListener('message', event => {
              const message = event.data;
              
              switch (message.command) {
                case 'updateSignInStatus':
                  if (message.isSignedIn) {
                    document.getElementById('signed-out').style.display = 'none';
                    document.getElementById('signed-in').style.display = 'block';
                    document.getElementById('user-display-name').textContent = message.userDisplayName;
                  } else {
                    document.getElementById('signed-out').style.display = 'block';
                    document.getElementById('signed-in').style.display = 'none';
                    document.getElementById('user-display-name').textContent = '';
                    document.getElementById('project-list').innerHTML = '';
                    isRealtimeSyncEnabled = false;
                    document.getElementById('sync-status').textContent = 'Off';
                  }
                  break;
                  
                case 'projectsLoaded':
                  const projectList = document.getElementById('project-list');
                  projectList.innerHTML = '';
                  
                  if (message.projects && message.projects.length > 0) {
                    message.projects.forEach(project => {
                      const projectItem = document.createElement('div');
                      projectItem.className = 'project-item';
                      projectItem.textContent = project.name;
                      projectList.appendChild(projectItem);
                    });
                  } else {
                    projectList.innerHTML = '<p>No projects found</p>';
                  }
                  break;
              }
            });
          }());
        </script>
      </body>
      </html>
    `;
  }
}

export function deactivate() {
  if (fsWatcher) {
    fsWatcher.dispose();
  }
}