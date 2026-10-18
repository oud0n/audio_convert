import type { AppProps } from 'next/app'
import '../styles/globals.css'
// Applies the saved theme (light / dark / system) and follows OS changes.
import '../utils/theme'
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
