# Firebase Project Manager Extension for VS Code

A VS Code extension that allows you to sync your projects with Firebase.

## Features

- **Google Authentication**: Sign in with your Google account via Firebase Authentication
- **Save Projects**: Save the structure of your current VS Code project to Firebase
- **List Projects**: View all your previously saved projects
- **Update Projects**: Update existing projects with your current workspace structure
- **Delete Projects**: Remove projects from your Firebase account
- **Logout**: Securely log out from your Firebase account

## Setup

1. Install the extension from the VS Code marketplace
2. Replace the Firebase config in `src/extension.ts` with your own Firebase project credentials
3. Make sure to enable Google Authentication in your Firebase project console

## Usage

1. Click the Firebase icon in the activity bar to open the sidebar
2. Sign in with your Google account using the "Sign In with Google" button
3. Use the other buttons in the sidebar to manage your projects:
   - "Save New Project" to save your current workspace
   - "Refresh Project List" to update the project list
   - "Update Current Project" to update an existing project
   - "Delete Project" to remove a project (select a project first)
   - "Logout" to sign out

## Requirements

- VS Code 1.70.0 or higher
- Node.js and npm for development

## Development

1. Clone the repository
2. Run `npm install` to install dependencies
3. Run `npm run compile` to build the extension
4. Press F5 to start debugging

## Firebase Setup Instructions

1. Create a new Firebase project at [firebase.google.com](https://firebase.google.com)
2. Enable Authentication and Firestore in your project
3. Set up Google as an authentication provider
4. Copy your Firebase config from the Firebase console and replace the placeholder in `src/extension.ts`
5. Make sure your Firestore security rules allow authenticated users to read/write their own data

```
/users/{userId}/projects/{projectId}
    ├── name: string  // Project name
    ├── fileNames: array  // List of project file paths
    ├── timestamp: timestamp  // When the project was created/updated

```

## Snapshot
<img width="1728" alt="image" src="https://github.com/user-attachments/assets/1a2c3d29-7b59-4c51-8806-f5b405bd1562" />
<img width="1660" alt="image" src="https://github.com/user-attachments/assets/c000bd34-86bc-42b5-9fa3-3e599a4095c9" />

