// Extension Entry Point: extension.ts
import * as vscode from 'vscode';
import * as firebase from 'firebase/app';
import { 
  getAuth, 
  signInWithCredential, 
  GoogleAuthProvider, 
  signOut, 
  onAuthStateChanged,
  OAuthCredential
} from 'firebase/auth';
import { 
  getFirestore, 
  collection, 
  addDoc, 
  getDocs, 
  doc, 
  updateDoc, 
  deleteDoc, 
  query, 
  where 
} from 'firebase/firestore';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as url from 'url';
import * as querystring from 'querystring';
import { randomBytes } from 'crypto';
import { promisify } from 'util';

// Firebase configuration
const firebaseConfig = {
	apiKey: "AIzaSyDjwbpX8wZFmA2dw0_XmNTLhN9BuvtnrwY",
	authDomain: "project-sync-fb-cld-test.firebaseapp.com",
	projectId: "project-sync-fb-cld-test",
	storageBucket: "project-sync-fb-cld-test.firebasestorage.app",
	messagingSenderId: "560523365397",
	appId: "1:560523365397:web:8308277e4cf1e7984f921c"
};

// Initialize Firebase
const app = firebase.initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Google OAuth configuration
const CLIENT_ID = "560523365397-5r1ba0ak8l15mo3vb45p2adrnfqgoh88.apps.googleusercontent.com";
const CLIENT_SECRET = "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";
const REDIRECT_URI = "http://localhost:3000/callback";
const SCOPES = ["email", "profile", "openid"];

let currentUser: any = null;
let activePanel: vscode.WebviewPanel | undefined = undefined;

export function activate(context: vscode.ExtensionContext) {
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
      await performGoogleOAuth(context);
    }),

    vscode.commands.registerCommand('firebase-project-sync.saveProject', async () => {
      if (!currentUser) {
        vscode.window.showErrorMessage('Please sign in first');
        return;
      }
      const projectName = await vscode.window.showInputBox({
        prompt: 'Enter project name',
        placeHolder: 'My Project'
      });
      if (projectName) {
        saveNewProject(projectName);
      }
    }),

    vscode.commands.registerCommand('firebase-project-sync.updateProject', async () => {
      if (!currentUser) {
        vscode.window.showErrorMessage('Please sign in first');
        return;
      }
      const projects = await getProjects();
      const projectItems = projects.map(p => ({ label: p.name, id: p.id }));
      
      const selectedProject = await vscode.window.showQuickPick(projectItems, {
        placeHolder: 'Select a project to update'
      });
      
      if (selectedProject) {
        updateProject(selectedProject.id, selectedProject.label);
      }
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
      const projects = await getProjects();
      const projectItems = projects.map(p => ({ label: p.name, id: p.id }));
      
      const selectedProject = await vscode.window.showQuickPick(projectItems, {
        placeHolder: 'Select a project to delete'
      });
      
      if (selectedProject) {
        deleteProject(selectedProject.id);
      }
    }),

    vscode.commands.registerCommand('firebase-project-sync.logout', () => {
      signOutUser();
    })
  );

  // Setup auth state listener
  onAuthStateChanged(auth, (user) => {
    if (user) {
      currentUser = user;
      provider.updateUser(user);
      vscode.window.showInformationMessage(`Signed in as ${user.displayName || user.email}`);
    } else {
      currentUser = null;
      provider.updateUser(null);
    }
  });

  // Try to restore auth session from stored credentials
  const storedCredentials = context.globalState.get('firebase-credentials');
  if (storedCredentials) {
    try {
      const provider = new GoogleAuthProvider();
      signInWithCredential(auth, storedCredentials as OAuthCredential)
        .catch(() => {
          // Silently fail if stored credentials are invalid
          context.globalState.update('firebase-credentials', undefined);
        });
    } catch (error) {
      // Clear invalid credentials
      context.globalState.update('firebase-credentials', undefined);
    }
  }
}

// Perform OAuth authentication with Google
async function performGoogleOAuth(context: vscode.ExtensionContext) {
  // Generate a random state value to prevent CSRF attacks
  const state = randomBytes(16).toString('hex');
  
  // Create OAuth URL
  const authUrl = `https://accounts.google.com/o/oauth2/auth?` +
    `client_id=${CLIENT_ID}&` +
    `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
    `response_type=code&` +
    `scope=${encodeURIComponent(SCOPES.join(' '))}&` +
    `state=${state}&` +
    `access_type=offline&` +
    `prompt=consent`;

  // Open browser for authentication
  vscode.env.openExternal(vscode.Uri.parse(authUrl));
  
  // Start a local server to handle the OAuth redirect
  const server = http.createServer();
  
  // Promise to resolve when auth is complete
  const authComplete = new Promise<{code: string, state: string}>((resolve, reject) => {
    server.on('request', (req, res) => {
      // Parse the URL and query parameters
      const parsedUrl = url.parse(req.url || '');
      const queryParams = querystring.parse(parsedUrl.query || '');
      
      // Check if this is the OAuth callback
      if (parsedUrl.pathname === '/callback') {
        // Close the response
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Authentication successful!</h1><p>You can close this window and return to VS Code.</p></body></html>');
        
        // Check state parameter to prevent CSRF
        if (queryParams.state !== state) {
          reject(new Error('Invalid authentication state'));
          server.close();
          return;
        }
        
        // Check for errors
        if (queryParams.error) {
          reject(new Error(`Authentication error: ${queryParams.error}`));
          server.close();
          return;
        }
        
        // Get the authorization code
        if (queryParams.code) {
          resolve({
            code: queryParams.code as string,
            state: queryParams.state as string
          });
          server.close();
        } else {
          reject(new Error('No authorization code received'));
          server.close();
        }
      }
    });
    
    // Listen on localhost:3000
    server.listen(3000);
  });
  
  try {
    vscode.window.showInformationMessage('Waiting for authentication in browser...');
    
    // Wait for the authorization code
    const { code } = await authComplete;
    
    // Exchange the code for tokens
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: querystring.stringify({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code'
      })
    });
    
	const tokenData = (await tokenResponse.json()) as { id_token?: string };
    
    if (!tokenData.id_token) {
      throw new Error('Failed to get ID token');
    }
    
    // Create credential from the ID token
    const credential = GoogleAuthProvider.credential(tokenData.id_token);
    
    // Sign in with Firebase using the credential
    const userCredential = await signInWithCredential(auth, credential);
    
    // Store the credential for future use
    context.globalState.update('firebase-credentials', credential);
    
    return userCredential.user;
  } catch (error: any) {
    vscode.window.showErrorMessage(`Authentication failed: ${error.message}`);
    throw error;
  }
}

// Sign out user
async function signOutUser() {
  try {
    await signOut(auth);
    vscode.window.showInformationMessage('Signed out successfully');
  } catch (error: any) {
    vscode.window.showErrorMessage(`Sign out failed: ${error.message}`);
  }
}

// Save new project
async function saveNewProject(projectName: string) {
  try {
    const files = await getWorkspaceFiles();
    
    if (files.length === 0) {
      vscode.window.showWarningMessage('No files found in the current workspace');
      return;
    }

    await addDoc(collection(db, 'projects'), {
      name: projectName,
      userId: currentUser.uid,
      files: files,
      createdAt: new Date()
    });

    vscode.window.showInformationMessage(`Project "${projectName}" saved successfully`);
  } catch (error: any) {
    vscode.window.showErrorMessage(`Failed to save project: ${error.message}`);
  }
}

// Update existing project
async function updateProject(projectId: string, projectName: string) {
  try {
    const files = await getWorkspaceFiles();
    
    if (files.length === 0) {
      vscode.window.showWarningMessage('No files found in the current workspace');
      return;
    }

    const projectRef = doc(db, 'projects', projectId);
    await updateDoc(projectRef, {
      files: files,
      updatedAt: new Date()
    });

    vscode.window.showInformationMessage(`Project "${projectName}" updated successfully`);
  } catch (error: any) {
    vscode.window.showErrorMessage(`Failed to update project: ${error.message}`);
  }
}

// Delete project
async function deleteProject(projectId: string) {
  try {
    const projectRef = doc(db, 'projects', projectId);
    await deleteDoc(projectRef);
    vscode.window.showInformationMessage('Project deleted successfully');
  } catch (error: any) {
    vscode.window.showErrorMessage(`Failed to delete project: ${error.message}`);
  }
}

// Get all projects for current user
async function getProjects() {
  try {
    const projectsQuery = query(
      collection(db, 'projects'),
      where('userId', '==', currentUser.uid)
    );
    
    const projectDocs = await getDocs(projectsQuery);
    return projectDocs.docs.map(doc => ({
      id: doc.id,
      name: doc.data().name,
      files: doc.data().files,
      createdAt: doc.data().createdAt
    }));
  } catch (error: any) {
    vscode.window.showErrorMessage(`Failed to fetch projects: ${error.message}`);
    return [];
  }
}

// Show project list in a webview
async function showProjectList() {
  try {
    const projects = await getProjects();
    
    if (projects.length === 0) {
      vscode.window.showInformationMessage('No projects found');
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
      projectListHtml += `
        <div class="project">
          <div class="project-name">${project.name}</div>
          <div>Created: ${new Date(project.createdAt.seconds * 1000).toLocaleString()}</div>
          <div>Files:</div>
          <ul class="file-list">
      `;

      project.files.forEach((file: string) => {
        projectListHtml += `<li>${file}</li>`;
      });

      projectListHtml += `
          </ul>
        </div>
      `;
    });

    projectListHtml += `
        </body>
      </html>
    `;

    activePanel.webview.html = projectListHtml;
  } catch (error: any) {
    vscode.window.showErrorMessage(`Failed to show project list: ${error.message}`);
  }
}

// Get all files in current workspace
async function getWorkspaceFiles(): Promise<string[]> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage('No workspace folder open');
    return [];
  }

  const rootPath = workspaceFolders[0].uri.fsPath;
  const files: string[] = [];

  // Function to recursively get all files
  const getFiles = (dirPath: string) => {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      
      // Skip node_modules, .git, and other hidden folders
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
          getFiles(fullPath);
        }
      } else {
        // Store relative path from workspace root
        const relativePath = path.relative(rootPath, fullPath);
        files.push(relativePath);
      }
    }
  };

  getFiles(rootPath);
  return files;
}

// Sidebar view provider
class FirebaseProjectSyncViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'firebase-project-sync.sidebar';
  private _view?: vscode.WebviewView;
  private _user: any = null;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public updateUser(user: any) {
    this._user = user;
    if (this._view) {
      this._updateView();
    }
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };
    
    this._updateView();
  }

  private _updateView() {
    if (!this._view) {
      return;
    }

    const isLoggedIn = !!this._user;
    
    this._view.webview.html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Firebase Project Sync</title>
        <style>
          body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            color: var(--vscode-foreground);
          }
          button {
            display: block;
            width: 100%;
            padding: 8px;
            margin: 10px 0;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 2px;
            cursor: pointer;
          }
          button:hover {
            background-color: var(--vscode-button-hoverBackground);
          }
          .user-info {
            margin-bottom: 20px;
            padding: 10px;
            border-radius: 4px;
            background-color: var(--vscode-editor-background);
          }
        </style>
      </head>
      <body>
        <h2>Firebase Project Sync</h2>
        
        ${isLoggedIn ? `
          <div class="user-info">
            <div>Signed in as:</div>
            <div><strong>${this._user.displayName || this._user.email}</strong></div>
          </div>
          <button id="saveBtn">Save New Project</button>
          <button id="listBtn">Project List</button>
          <button id="updateBtn">Update Project</button>
          <button id="deleteBtn">Delete Project</button>
          <button id="logoutBtn">Logout</button>
        ` : `
          <button id="loginBtn">Sign in with Google</button>
        `}

        <script>
          const vscode = acquireVsCodeApi();
          
          ${isLoggedIn ? `
            document.getElementById('saveBtn').addEventListener('click', () => {
              vscode.postMessage({ command: 'saveProject' });
            });
            
            document.getElementById('listBtn').addEventListener('click', () => {
              vscode.postMessage({ command: 'listProjects' });
            });
            
            document.getElementById('updateBtn').addEventListener('click', () => {
              vscode.postMessage({ command: 'updateProject' });
            });
            
            document.getElementById('deleteBtn').addEventListener('click', () => {
              vscode.postMessage({ command: 'deleteProject' });
            });
            
            document.getElementById('logoutBtn').addEventListener('click', () => {
              vscode.postMessage({ command: 'logout' });
            });
          ` : `
            document.getElementById('loginBtn').addEventListener('click', () => {
              vscode.postMessage({ command: 'signIn' });
            });
          `}
        </script>
      </body>
      </html>
    `;

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
          break;
      }
    });
  }
}

export function deactivate() {}