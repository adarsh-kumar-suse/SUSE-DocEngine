import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, setPersistence, browserLocalPersistence } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

console.log('Firebase: Initializing with config:', firebaseConfig.projectId);

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

// Enable persistent authentication
setPersistence(auth, browserLocalPersistence)
  .then(() => {
    console.log('Firebase: Persistence enabled successfully');
  })
  .catch((error) => {
    console.error("Firebase: Failed to set persistence:", error);
  });

export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });
console.log('Firebase: Google provider configured');
