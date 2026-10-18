import { Html, Head, Main, NextScript } from 'next/document';

// Sets the theme class before the page draws (same storage key and rule as
// utils/theme.ts), so a light theme never flashes dark on start.
const themeScript = `(function(){try{var s=localStorage.getItem('ac_theme');var l=s==='light'||((!s||s==='system')&&window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches);document.documentElement.classList.add(l?'light':'dark');}catch(e){document.documentElement.classList.add('dark');}})();`;

export default function Document() {
  return (
    <Html>
      <Head />
      <body>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
