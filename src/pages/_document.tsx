import { Html, Head, Main, NextScript } from 'next/document'

export default function Document() {
  return (
    <Html lang="en">
      <Head />
      <body>
        <script
          // Static pre-paint theme script (no user input); must run before hydration to avoid a flash
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('theme');if(t==='dark'||t==='light'){document.documentElement.dataset.theme=t;}}catch(e){}try{if(new URLSearchParams(location.search).get('tokenId')){document.documentElement.setAttribute('data-has-token','');}}catch(e){}`,
          }}
        />
        <Main />
        <NextScript />
      </body>
    </Html>
  )
}
