import type { AppProps } from 'next/app'
import '../styles/globals.css'
import { AudioConverterProvider } from '../context/AudioConverterContext'
import Layout from '../components/Layout'

function MyApp({ Component, pageProps }: AppProps) {
  return (
    <AudioConverterProvider>
      <Layout>
        <Component {...pageProps} />
      </Layout>
    </AudioConverterProvider>
  )
}

export default MyApp
