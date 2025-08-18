import React from 'react';
import { supabase } from './supabaseClient';

export default function ForgotPassword() {
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = new FormData(e.currentTarget).get('email') as string;
    if (!email) return;
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: 'https://acssalary.netlify.app/auth/callback',
    });
    if (error) return alert(error.message);
    alert('Password reset email sent. Check your inbox.');
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <div className="bg-white w-full max-w-sm p-6 rounded-xl shadow-md">
        <h1 className="text-xl font-semibold text-center text-blue-900 mb-4">Reset Password</h1>
        <form onSubmit={onSubmit} className="space-y-3">
          <input type="email" name="email" placeholder="Your email"
            className="w-full px-4 py-2 border rounded-md focus:ring" required/>
          <button className="w-full bg-blue-900 text-white py-2 rounded-md hover:bg-blue-800" type="submit">
            Send reset link
          </button>
        </form>
      </div>
    </div>
  );
}
