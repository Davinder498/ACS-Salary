// cacheCleaner.ts
export function clearBrowserCache(): void {
  // Unregister service workers
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then((registrations) => {
      registrations.forEach((registration) => {
        registration.unregister().then(() => {
          console.log('Service Worker unregistered:', registration.scope);
        });
      });
    });
  }

  // Clear caches
  if ('caches' in window) {
    caches.keys().then((keys) => {
      keys.forEach((key) => {
        caches.delete(key).then(() => {
          console.log('Cache deleted:', key);
        });
      });
    });
  }

  // Clear local and session storage
  try {
    localStorage.clear();
    sessionStorage.clear();
    console.log('LocalStorage and SessionStorage cleared');
  } catch (e) {
    console.warn('Error clearing storage:', e);
  }
}
