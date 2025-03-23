import { initializeApp } from 'firebase/app';
import * as vscode from 'vscode';
import { getAuth, signInWithPopup, signInWithRedirect, GoogleAuthProvider, signInWithCredential, signOut, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, addDoc, getDocs, updateDoc, doc, deleteDoc, serverTimestamp, setDoc, getDoc, onSnapshot } from 'firebase/firestore';
import { randomBytes } from 'crypto';
import * as http from 'http';
import * as url from 'url';
import * as querystring from 'querystring';

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyDjwbpX8wZFmA2dw0_XmNTLhN9BuvtnrwY",
  authDomain: "project-sync-fb-cld-test.firebaseapp.com",
  projectId: "project-sync-fb-cld-test",
  storageBucket: "project-sync-fb-cld-test.firebasestorage.app",
  messagingSenderId: "560523365397",
  appId: "1:560523365397:web:8308277e4cf1e7984f921c"
};

// Google OAuth configuration
const CLIENT_ID = "560523365397-5r1ba0ak8l15mo3vb45p2adrnfqgoh88.apps.googleusercontent.com";
const CLIENT_SECRET = "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";
const REDIRECT_URI = "http://localhost:3000/callback";
const SCOPES = ["email", "profile", "openid"];

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
auth.languageCode = 'en';


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


async function signOutUser() {
  try {
    await signOut(auth);
    vscode.window.showInformationMessage('Signed out successfully');
  } catch (error: any) {
    vscode.window.showErrorMessage(`Sign out failed: ${error.message}`);
  }
}


export { auth, db,serverTimestamp, signInWithPopup, signInWithRedirect, collection, addDoc, getDocs, updateDoc, setDoc, getDoc, doc, deleteDoc, signOutUser, performGoogleOAuth, onAuthStateChanged, onSnapshot};