import React from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import { getRedirectResult, signInWithPopup, signInWithRedirect, GoogleAuthProvider } from 'firebase/auth';
import { auth, googleProvider } from '../lib/firebase';
import { FileText, Github, ShieldCheck } from 'lucide-react';
import { motion } from 'motion/react';
import type { SessionUser } from '../lib/session';

type LoginProps = {
  onAuthenticated: (user: SessionUser) => void;
};

type AuthTab = 'google' | 'email';
type EmailMode = 'login' | 'signup';

export default function Login({ onAuthenticated }: LoginProps) {
  const navigate = useNavigate();
  const [error, setError] = React.useState<string>('');
  const [isLoading, setIsLoading] = React.useState(false);
  const [authTab, setAuthTab] = React.useState<AuthTab>('google');
  const [emailMode, setEmailMode] = React.useState<EmailMode>('login');
  const [identifier, setIdentifier] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [username, setUsername] = React.useState('');
  const [displayName, setDisplayName] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');

  const handleBackendSession = async () => {
    const meResponse = await axios.get('/api/auth/me');
    const sessionUser = meResponse.data?.user as SessionUser | undefined;
    if (!sessionUser) {
      throw new Error('Authentication succeeded but no active session was found.');
    }
    const inviteToken = new URLSearchParams(window.location.search).get('invite');
    if (inviteToken) {
      try {
        await axios.post('/api/invites/accept', { token: inviteToken });
      } catch (inviteError: unknown) {
        const inviteMessage =
          (inviteError as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message;
        if (inviteMessage) {
          setError(inviteMessage);
        }
      }
    }
    onAuthenticated(sessionUser);
    navigate('/');
  };

  const completeGoogleSession = async () => {
    const currentUser = auth.currentUser;
    if (!currentUser) {
      throw new Error('Google sign-in did not return a user session.');
    }
    const idToken = await currentUser.getIdToken(true);
    const response = await axios.post('/api/auth/google', { idToken });
    const sessionUser = response.data?.user as SessionUser | undefined;
    if (sessionUser) {
      onAuthenticated(sessionUser);
      navigate('/');
      return;
    }
    await handleBackendSession();
  };

  React.useEffect(() => {
    const checkRedirectResult = async () => {
      try {
        const result = await getRedirectResult(auth);
        if (result?.user) {
          const credential = GoogleAuthProvider.credentialFromResult(result);
          if (credential?.accessToken) {
            localStorage.setItem('google_token', credential.accessToken);
          }
          await completeGoogleSession();
        }
      } catch (redirectError: unknown) {
        const redirectMessage =
          redirectError instanceof Error ? redirectError.message : 'Google redirect sign-in failed.';
        setError(redirectMessage);
      }
    };
    checkRedirectResult();
  }, []);

  const handleGoogleLogin = async () => {
    setError('');
    setIsLoading(true);
    try {
      const result = await signInWithPopup(auth, googleProvider);
      const credential = GoogleAuthProvider.credentialFromResult(result);
      if (credential?.accessToken) {
        localStorage.setItem('google_token', credential.accessToken);
      }
      await completeGoogleSession();
    } catch (googleError: unknown) {
      const code = (googleError as { code?: string })?.code || '';
      const shouldRedirectFallback =
        code === 'auth/popup-blocked' ||
        code === 'auth/popup-closed-by-user' ||
        code === 'auth/cancelled-popup-request' ||
        code === 'auth/web-storage-unsupported';

      if (shouldRedirectFallback) {
        await signInWithRedirect(auth, googleProvider);
        return;
      }
      const responseError = (googleError as {
        response?: { data?: { error?: { message?: string; details?: { requestId?: string } } } };
      })?.response?.data?.error;
      const message = responseError?.message || (googleError instanceof Error ? googleError.message : 'Google login failed.');
      const requestId = responseError?.details?.requestId;
      const enrichedMessage = requestId ? `${message} (requestId: ${requestId})` : message;
      if ((googleError as { response?: unknown })?.response) {
        console.error('Google backend auth error', googleError);
      }
      setError(enrichedMessage);
    } finally {
      setIsLoading(false);
    }
  };

  const handleEmailAuth = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setIsLoading(true);
    try {
      if (emailMode === 'signup') {
        if (password !== confirmPassword) {
          throw new Error('Passwords do not match.');
        }
        await axios.post('/api/auth/signup', {
          email,
          username: username || undefined,
          displayName: displayName || undefined,
          password,
        });
      } else {
        await axios.post('/api/auth/login', {
          identifier,
          password,
        });
      }

      await auth.signOut().catch(() => undefined);
      localStorage.removeItem('google_token');
      await handleBackendSession();
    } catch (authError: unknown) {
      const apiMessage = (authError as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error
        ?.message;
      const message = apiMessage || (authError instanceof Error ? authError.message : 'Authentication failed.');
      setError(message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleClearCache = async () => {
    localStorage.clear();
    sessionStorage.clear();
    try {
      await axios.post('/api/auth/logout');
    } catch {
      // Ignore API logout failures when doing local cleanup.
    }
    auth.signOut().catch(() => undefined);
    setError('');
    window.location.reload();
  };

  return (
    <div className="min-h-screen bg-suse-dark flex items-center justify-center p-4 relative overflow-hidden">
      <div className="absolute top-0 left-0 w-full h-full opacity-10 pointer-events-none">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-suse-pine rounded-full blur-[120px]" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-suse-water rounded-full blur-[120px]" />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md suse-card p-10 relative z-10"
      >
        <div className="flex flex-col items-center text-center mb-8">
          <div className="mb-6">
            <img
              src="/suse-logo.svg"
              alt="SUSE Logo"
              className="w-24 h-24 drop-shadow-[0_0_20px_rgba(48,186,120,0.3)]"
              referrerPolicy="no-referrer"
            />
          </div>
          <h1 className="text-3xl font-bold mb-2">SUSE DocEngine</h1>
          <p className="text-gray-400">Enterprise Documentation Automation</p>
        </div>

        <div className="space-y-6 mb-8">
          <div className="flex items-start gap-4">
            <div className="p-2 bg-suse-pine/10 rounded-lg">
              <FileText className="text-suse-pine w-5 h-5" />
            </div>
            <div>
              <h3 className="font-semibold">Google Docs Import</h3>
              <p className="text-sm text-gray-400">Seamlessly fetch your technical content.</p>
            </div>
          </div>
          <div className="flex items-start gap-4">
            <div className="p-2 bg-suse-pine/10 rounded-lg">
              <ShieldCheck className="text-suse-pine w-5 h-5" />
            </div>
            <div>
              <h3 className="font-semibold">SUSE Compliance</h3>
              <p className="text-sm text-gray-400">DAPS-compatible AsciiDoc generation.</p>
            </div>
          </div>
          <div className="flex items-start gap-4">
            <div className="p-2 bg-suse-pine/10 rounded-lg">
              <Github className="text-suse-pine w-5 h-5" />
            </div>
            <div>
              <h3 className="font-semibold">GitHub Sync</h3>
              <p className="text-sm text-gray-400">Automated PRs for your documentation repos.</p>
            </div>
          </div>
        </div>

        <div className="mb-5 flex rounded-xl border border-white/10 p-1 bg-suse-dark/60">
          <button
            type="button"
            onClick={() => setAuthTab('google')}
            className={`flex-1 rounded-lg py-2 text-sm font-semibold transition-colors ${
              authTab === 'google' ? 'bg-suse-pine text-suse-dark' : 'text-gray-300 hover:text-white'
            }`}
          >
            Google
          </button>
          <button
            type="button"
            onClick={() => setAuthTab('email')}
            className={`flex-1 rounded-lg py-2 text-sm font-semibold transition-colors ${
              authTab === 'email' ? 'bg-suse-pine text-suse-dark' : 'text-gray-300 hover:text-white'
            }`}
          >
            Email & Password
          </button>
        </div>

        {error && (
          <div className="mb-6 p-4 bg-red-500/10 border border-red-500/30 rounded-xl text-red-300 text-sm">
            {error}
          </div>
        )}

        {authTab === 'google' ? (
          <button
            onClick={handleGoogleLogin}
            disabled={isLoading}
            className="w-full suse-button-primary flex items-center justify-center gap-3 py-3 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoading ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent"></div>
                Signing in...
              </>
            ) : (
              <>
                <img src="https://www.google.com/favicon.ico" alt="Google" className="w-4 h-4 bg-white rounded-full p-0.5" />
                Sign in with Google
              </>
            )}
          </button>
        ) : (
          <form className="space-y-3" onSubmit={handleEmailAuth}>
            <div className="flex rounded-xl border border-white/10 p-1 bg-suse-dark/60">
              <button
                type="button"
                onClick={() => setEmailMode('login')}
                className={`flex-1 rounded-lg py-2 text-xs font-semibold transition-colors ${
                  emailMode === 'login' ? 'bg-suse-pine text-suse-dark' : 'text-gray-300 hover:text-white'
                }`}
              >
                Login
              </button>
              <button
                type="button"
                onClick={() => setEmailMode('signup')}
                className={`flex-1 rounded-lg py-2 text-xs font-semibold transition-colors ${
                  emailMode === 'signup' ? 'bg-suse-pine text-suse-dark' : 'text-gray-300 hover:text-white'
                }`}
              >
                Sign Up
              </button>
            </div>

            {emailMode === 'signup' ? (
              <>
                <input
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  type="email"
                  required
                  placeholder="Email"
                  className="w-full rounded-lg border border-white/10 bg-suse-dark/70 px-3 py-2 text-sm focus:border-suse-pine focus:outline-none"
                />
                <input
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  type="text"
                  placeholder="Username (optional)"
                  className="w-full rounded-lg border border-white/10 bg-suse-dark/70 px-3 py-2 text-sm focus:border-suse-pine focus:outline-none"
                />
                <input
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  type="text"
                  placeholder="Display name (optional)"
                  className="w-full rounded-lg border border-white/10 bg-suse-dark/70 px-3 py-2 text-sm focus:border-suse-pine focus:outline-none"
                />
              </>
            ) : (
              <input
                value={identifier}
                onChange={(event) => setIdentifier(event.target.value)}
                type="text"
                required
                placeholder="Email or username"
                className="w-full rounded-lg border border-white/10 bg-suse-dark/70 px-3 py-2 text-sm focus:border-suse-pine focus:outline-none"
              />
            )}

            <input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              required
              placeholder="Password"
              className="w-full rounded-lg border border-white/10 bg-suse-dark/70 px-3 py-2 text-sm focus:border-suse-pine focus:outline-none"
            />
            {emailMode === 'signup' && (
              <input
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                type="password"
                required
                placeholder="Confirm password"
                className="w-full rounded-lg border border-white/10 bg-suse-dark/70 px-3 py-2 text-sm focus:border-suse-pine focus:outline-none"
              />
            )}

            <button
              type="submit"
              disabled={isLoading}
              className="w-full suse-button-primary flex items-center justify-center gap-3 py-3 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isLoading ? 'Processing...' : emailMode === 'signup' ? 'Create Account' : 'Login'}
            </button>

            <p className="text-xs text-gray-400">
              Test fallback credentials: <span className="font-mono text-gray-200">admin / admin123</span>
            </p>
          </form>
        )}

        <button
          onClick={handleClearCache}
          className="mt-4 w-full text-center text-xs text-gray-400 hover:text-gray-200 py-2 px-4 rounded-lg hover:bg-white/5 transition-colors"
        >
          Clear Cache & Sign Out
        </button>

        <p className="mt-8 text-center text-xs text-gray-500 uppercase tracking-widest">
          Secured by SUSE Enterprise Standards
        </p>
      </motion.div>
    </div>
  );
}
