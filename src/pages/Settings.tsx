import React, { useState, useEffect } from 'react';
import { Palette, CheckCircle2, Moon, Sun, Shield, Github, Key, Save, History, Trash2, GitBranch } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import axios from 'axios';

export default function Settings() {
  const [theme, setTheme] = useState(localStorage.getItem('theme') || 'dark-green');
  const [githubToken, setGithubToken] = useState('');
  const [defaultRepo, setDefaultRepo] = useState('');
  const [saved, setSaved] = useState(false);
  const [tokenHistory, setTokenHistory] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<'appearance' | 'integrations'>('appearance');
  const isLight = theme === 'light-green';
  const panelBg = isLight ? 'bg-white/80 border-suse-pine/20 text-gray-700' : 'bg-[#08120e] border-suse-pine/30 text-white';

  const applyTheme = (themeName: string) => {
    document.documentElement.classList.remove('dark-green', 'light-green');
    document.documentElement.classList.add(themeName === 'light-green' ? 'light-green' : 'dark-green');
  };

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const response = await axios.get('/api/user/settings');
        setGithubToken(response.data?.githubToken || '');
        setDefaultRepo(response.data?.defaultRepo || '');
      } catch {
        setGithubToken('');
        setDefaultRepo('');
      }
    };
    loadSettings();
    const history = localStorage.getItem('github_token_history');
    if (history) {
      setTokenHistory(JSON.parse(history));
    }
  }, []);

  const handleSave = async () => {
    localStorage.setItem('theme', theme);
    applyTheme(theme);
    await axios.put('/api/user/settings', { githubToken, defaultRepo }).catch(() => undefined);
    
    if (githubToken) {
      const updatedHistory = [githubToken, ...tokenHistory.filter(t => t !== githubToken)].slice(0, 10);
      setTokenHistory(updatedHistory);
      localStorage.setItem('github_token_history', JSON.stringify(updatedHistory));
    }

    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  const clearHistory = () => {
    setTokenHistory([]);
    localStorage.removeItem('github_token_history');
  };

  const maskToken = (token: string) => {
    if (token.length <= 8) return '****';
    return `${token.substring(0, 4)}...${token.substring(token.length - 4)}`;
  };

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      <div>
        <h1 className="text-3xl font-bold mb-2">Settings</h1>
        <p className="text-gray-400 uppercase font-mono text-xs tracking-widest">Manage your environment and external connections</p>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-4 border-b border-suse-pine/20 pb-4">
        <button
          onClick={() => setActiveTab('appearance')}
          className={`flex items-center gap-2 px-4 py-2 font-bold uppercase tracking-widest text-xs transition-colors rounded-xl ${activeTab === 'appearance' ? 'bg-suse-pine text-suse-dark' : 'text-gray-400 hover:text-white'}`}
        >
          <Palette size={16} /> Appearance
        </button>
        <button
          onClick={() => setActiveTab('integrations')}
          className={`flex items-center gap-2 px-4 py-2 font-bold uppercase tracking-widest text-xs transition-colors rounded-xl ${activeTab === 'integrations' ? 'bg-suse-pine text-suse-dark' : 'text-gray-400 hover:text-white'}`}
        >
          <GitBranch size={16} /> Integrations
        </button>
      </div>

      <div className="grid gap-6">
        {activeTab === 'appearance' && (
          <div className="suse-card p-8 animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center gap-4 mb-8">
              <div className="p-3 bg-white/5 rounded-2xl">
                <Palette size={32} className="text-suse-pine" />
              </div>
              <div>
                <h2 className="text-xl font-semibold">Theme Selection</h2>
                <p className="text-sm text-gray-400">Choose between dark green and light green themes.</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <button 
                onClick={() => setTheme('dark-green')}
                className={`p-6 rounded-xl border flex flex-col items-center gap-3 transition-all ${
                  theme === 'dark-green' 
                    ? 'bg-suse-pine/10 border-suse-pine text-suse-pine shadow-[0_0_15px_rgba(48,186,120,0.2)]' 
                    : 'bg-white/5 border-white/10 text-gray-400 hover:bg-white/10'
                }`}
              >
                <Moon size={24} />
                <span className="font-bold">Dark Green</span>
              </button>
              <button 
                onClick={() => setTheme('light-green')}
                className={`p-6 rounded-xl border flex flex-col items-center gap-3 transition-all ${
                  theme === 'light-green' 
                    ? 'bg-suse-pine/10 border-suse-pine text-suse-pine shadow-[0_0_15px_rgba(48,186,120,0.2)]' 
                    : 'bg-white/5 border-white/10 text-gray-400 hover:bg-white/10'
                }`}
              >
                <Sun size={24} />
                <span className="font-bold">Light Green</span>
              </button>
            </div>
          </div>
        )}

        {activeTab === 'integrations' && (
          <div className="animate-in fade-in zoom-in-95 duration-200 space-y-6">
            <div className="suse-card p-8">
              <div className="flex items-center gap-4 mb-8">
                <div className="p-3 bg-white/5 rounded-2xl">
                  <Github size={32} className="text-suse-pine" />
                </div>
                <div>
                  <h2 className="text-xl font-semibold">GitHub Automation</h2>
                  <p className="text-sm text-gray-400">Provide a Personal Access Token (PAT) with repo permissions to sync your document.</p>
                </div>
              </div>

              <div className="space-y-6">
                <div className="space-y-2">
                  <label className="text-xs font-mono text-suse-pine font-bold uppercase tracking-widest px-1 flex items-center gap-2">
                    <Key size={12} /> Personal Access Token
                  </label>
                  <input 
                    type="password" 
                    value={githubToken}
                    onChange={(e) => setGithubToken(e.target.value)}
                    placeholder="ghp_xxxxxxxxxxxx"
                    className={`w-full border rounded-xl px-4 py-3 font-mono focus:outline-none focus:border-suse-pine transition-all ${panelBg}`}
                  />
                  <p className="text-[10px] text-gray-500 italic px-1">
                    Token is saved for your authenticated user profile and used as your default GitHub credential.
                  </p>
                </div>
                
                {tokenHistory.length > 0 && (
                  <div className={`space-y-3 p-5 rounded-xl border ${isLight ? 'bg-white/85 border-suse-pine/20' : 'bg-[#08120e] border-white/10'}`}>
                    <div className="flex items-center justify-between px-1">
                      <label className="text-xs font-mono text-gray-400 font-bold uppercase tracking-widest flex items-center gap-2">
                        <History size={12} /> Token History
                      </label>
                      <button 
                        onClick={clearHistory}
                        className="text-[10px] text-red-500 hover:text-red-400 transition-colors uppercase tracking-widest font-bold flex items-center gap-1"
                      >
                        <Trash2 size={10} /> Clear
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {tokenHistory.map((token, idx) => (
                        <button
                          key={idx}
                          onClick={() => setGithubToken(token)}
                          className={`text-[10px] px-3 py-1.5 rounded-full font-mono transition-all border ${
                            githubToken === token 
                              ? 'bg-suse-pine/20 text-suse-pine border-suse-pine shadow-[0_0_10px_rgba(48,186,120,0.2)]' 
                              : 'bg-white/5 text-gray-400 hover:text-white border-white/10 hover:bg-white/10'
                          }`}
                        >
                          {maskToken(token)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="space-y-2">
                  <label className="text-xs font-mono text-suse-pine font-bold uppercase tracking-widest px-1 flex items-center gap-2">
                    <Github size={12} /> Default Sync Repository
                  </label>
                  <input 
                    type="text" 
                    value={defaultRepo}
                    onChange={(e) => setDefaultRepo(e.target.value)}
                    placeholder="suse/documentation-project"
                    className={`w-full border rounded-xl px-4 py-3 font-mono focus:outline-none focus:border-suse-pine transition-all ${panelBg}`}
                  />
                </div>
              </div>
            </div>

            <div className="suse-card p-6 border-l-4 border-l-suse-pine">
              <div className="flex items-start gap-4">
                <Shield className="text-suse-pine shrink-0" size={24} />
                <div className="space-y-1">
                  <h3 className="font-semibold text-white">Security Protocol</h3>
                  <p className="text-sm text-gray-400 leading-relaxed font-mono">
                    Project creation requires a repository and starts prefilled from your default repo. Shared projects continue using the project owner repo configuration.
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="flex justify-end gap-4 mt-4">
          <AnimatePresence>
            {saved && (
              <motion.div 
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0 }}
                className="flex items-center gap-2 text-suse-pine text-sm font-bold uppercase tracking-widest"
              >
                <CheckCircle2 size={18} />
                Saved
              </motion.div>
            )}
          </AnimatePresence>
          <button 
            onClick={handleSave}
            className="flex items-center gap-2 px-10 py-3 rounded-xl font-bold uppercase tracking-wider text-suse-dark bg-suse-pine hover:bg-[#259b62] hover:shadow-[0_0_20px_rgba(48,186,120,0.4)] transition-all active:scale-95"
          >
            <Save size={18} />
            Commit Configuration
          </button>
        </div>
      </div>
    </div>
  );
}
