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
    <div className="auth-page">
      <div className="auth-card">
        <h1 className="auth-title">ACS Salary Calculator</h1>
        <p className="auth-sub">
          {mode === 'login'
            ? 'Log in to view your schedule and pay history.'
            : 'Create your account to start tracking pay and shifts.'}
        </p>

        <form onSubmit={mode === 'login' ? onLogin : onSignup} className="auth-form">
          <input
            className="input"
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
          />
          <input
            className="input"
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          />

          <button type="submit" className="btn btn-primary">
            {mode === 'login' ? 'Log In' : 'Create Account'}
          </button>
        </form>

        <div className="auth-actions">
          <button className="btn btn-link" onClick={() => (window.location.hash = '#forgot')}>
            Forgot password?
          </button>
          <button
            className="btn btn-link"
            onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}
          >
            {mode === 'login' ? 'Need an account?' : 'Have an account?'}
          </button>
        </div>
      </div>
    </div>
  );
}
