import React from 'react';
import { auth } from '../lib/firebase';

export default function Debug() {
  return (
    <div className="p-8 max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">Debug Info</h1>
      
      <div className="space-y-4 bg-white/5 p-4 rounded-lg">
        <div>
          <h2 className="font-semibold mb-2">Current Auth State:</h2>
          <pre className="bg-black/20 p-3 rounded text-sm overflow-auto">
            {JSON.stringify({
              uid: auth.currentUser?.uid,
              email: auth.currentUser?.email,
              displayName: auth.currentUser?.displayName,
              photoURL: auth.currentUser?.photoURL,
              emailVerified: auth.currentUser?.emailVerified,
              isAnonymous: auth.currentUser?.isAnonymous,
            }, null, 2)}
          </pre>
        </div>
        
        <div>
          <h2 className="font-semibold mb-2">LocalStorage - google_token:</h2>
          <pre className="bg-black/20 p-3 rounded text-sm">
            {localStorage.getItem('google_token') ? '✓ Token exists' : '✗ No token'}
          </pre>
        </div>
        
        <div>
          <h2 className="font-semibold mb-2">Firebase App Config:</h2>
          <pre className="bg-black/20 p-3 rounded text-sm overflow-auto">
            {JSON.stringify({
              projectId: 'heroviredacademics',
              authDomain: 'heroviredacademics.firebaseapp.com',
              initialized: auth.app ? 'Yes' : 'No',
            }, null, 2)}
          </pre>
        </div>

        <button 
          onClick={() => {
            console.log("Current user:", auth.currentUser);
            alert('Check console for details');
          }}
          className="bg-suse-pine hover:bg-suse-pine/80 text-white px-4 py-2 rounded"
        >
          Log to Console
        </button>
      </div>
    </div>
  );
}
