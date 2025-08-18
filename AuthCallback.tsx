import React, { useEffect, useState } from 'react';
import { supabase } from './supabaseClient';

export default function AuthCallback() {
  const [loading, setLoading] = useState(true);
  const [recovery, setRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const params = new URLSearchParams(window.location.search);
        setRecovery(params.get('type') === 'recovery');
      } catch (e: any) {
        setError(e?.message || 'Unexpected error');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function onSetPassword(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const pwd = new FormData(e.currentTarget).get('password') as string;
    if (!pwd || pwd.length < 8) return alert('Use at least 8 characters.');
    const { error } = await supabase.auth.updateUser({ password: pwd });
    if (error) return alert(error.message);
    alert('Password updated. Please log in.');
    window.location.href = '/';
  }

  if (loading) return <p style={{ padding:16 }}>Loading…</p>;
  if (error) return <p style={{ padding:16 }}>Error: {error}</p>;

  if (recovery) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
        <div className="bg-white w-full max-w-sm p-6 rounded-xl shadow-md">
          <h1 className="text-xl font-semibold text-center text-blue-900 mb-4">Set New Password</h1>
          <form onSubmit={onSetPassword} className="space-y-3">
            <input type="password" name="password" placeholder="New password"
              className="w-full px-4 py-2 border rounded-md focus:ring" required/>
            <button className="w-full bg-blue-900 text-white py-2 rounded-md hover:bg-blue-800" type="submit">
              Save
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding:16 }}>
      <h2>Thanks! Your email is confirmed.</h2>
      <p>You can close this tab or <a href="/">return to the app</a>.</p>
    </div>
  );
}
