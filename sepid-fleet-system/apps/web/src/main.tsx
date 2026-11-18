import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  const [status, setStatus] = useState('در حال بررسی دسترسی…');

  useEffect(() => {
    const request = new AbortController();
    async function checkAvailability() {
      try {
        const response = await fetch('/api/v1/health/ready', {
          signal: request.signal,
        });
        setStatus(response.ok ? 'محیط توسعه آماده است.' : 'سامانه در دسترس نیست.');
      } catch {
        if (!request.signal.aborted) setStatus('سامانه در دسترس نیست.');
      }
    }
    void checkAvailability();
    return () => request.abort();
  }, []);

  return (
    <main>
      <h1>سامانه ناوگان سپید</h1>
      <p role="status">{status}</p>
    </main>
  );
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
