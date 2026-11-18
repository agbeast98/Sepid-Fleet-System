/// <reference types="vite/client" />
import '../legacy/assets/css/style.css';
import runtime from '../legacy/assets/js/app.js?url&no-inline';

const script = document.createElement('script');
script.src = runtime;
script.addEventListener('error', () => {
  const target = document.getElementById('app');
  if (target) target.textContent = 'بارگیری سامانه انجام نشد. صفحه را دوباره باز کنید.';
});
document.head.append(script);
