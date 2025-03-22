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
  setDoc,
  getDoc,
  doc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
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
import { timeStamp } from 'console';

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

interface Project {
  id: string;
  fileNames?: string[];
  timestamps?: { seconds: number; nanoseconds: number }; // Firestore timestamps
}

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
      vscode.window.showInformationMessage('Signing Success : ', currentUser.displayName || currentUser.email);
      await createUser(currentUser.uid, currentUser.displayName || currentUser.email);
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
  const authComplete = new Promise<{ code: string, state: string }>((resolve, reject) => {
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
async function saveNewProject() {
  try {
    const projectName = vscode.workspace.name;
    if (!projectName) {
      vscode.window.showErrorMessage('Project name is required.');
      return;
    }

    // Generate project reference
    const projectRef = doc(db, 'users', currentUser.uid , 'projects', projectName);
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

    const projectRef = doc(db, 'users', currentUser.uid , 'projects', projectId);
    const projectSnap = await getDoc(projectRef);

    if (!projectSnap.exists()) {
      vscode.window.showErrorMessage('Project does not exist!');
      return;
    }

    const files = await vscode.workspace.findFiles('**/*');
    const fileNames = files.map(file => file.fsPath);

    await updateDoc(projectRef, { 
      fileNames ,
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

class FirebaseProjectSyncViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'firebase-project-sync.sidebar';
  private _view?: vscode.WebviewView;
  private _user: any = null;

  constructor(private readonly _extensionUri: vscode.Uri) { }

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