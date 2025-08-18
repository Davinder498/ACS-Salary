import React, { useState } from 'react';
import { supabase } from './supabaseClient';

export default function Login() {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  async function onLogin(e: React.FormEvent) {
    e.preventDefault();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return alert(error.message);
    window.location.href = '/';
  }

  async function onSignup(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) return alert('Use at least 8 characters.');
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: 'https://acssalary.netlify.app/auth/callback' },
    });
    if (error) return alert(error.message);
    alert('Check your email to confirm your account.');
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <div className="bg-white w-full max-w-sm p-6 rounded-xl shadow-md">
        <h1 className="text-2xl font-bold text-center text-blue-900 mb-6">ACS Salary Calculator</h1>

        <form onSubmit={mode === 'login' ? onLogin : onSignup} className="space-y-3">
          <input type="email" placeholder="Email"
            className="w-full px-4 py-2 border rounded-md focus:ring focus:ring-blue-300"
            value={email} onChange={e=>setEmail(e.target.value)} required/>
          <input type="password" placeholder="Password"
            className="w-full px-4 py-2 border rounded-md focus:ring focus:ring-blue-300"
            value={password} onChange={e=>setPassword(e.target.value)} required/>
          <button type="submit" className="w-full bg-blue-900 text-white py-2 rounded-md hover:bg-blue-800">
            {mode === 'login' ? 'Log In' : 'Create Account'}
          </button>
        </form>

        <div className="flex items-center justify-between text-sm mt-4">
          <button className="text-blue-700 hover:underline" onClick={()=> (window.location.hash = '#forgot')}>
            Forgot password?
          </button>
          <button className="text-gray-600 hover:underline" onClick={()=> setMode(mode==='login'?'signup':'login')}>
            {mode === 'login' ? 'Need an account?' : 'Have an account?'}
          </button>
        </div>
      </div>
    </div>
  );
}
