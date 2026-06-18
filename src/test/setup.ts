import '@testing-library/jest-dom'
import { TextEncoder, TextDecoder } from 'util'

// React Router v7 requires TextEncoder/TextDecoder in jsdom
Object.defineProperty(globalThis, 'TextEncoder', { value: TextEncoder })
Object.defineProperty(globalThis, 'TextDecoder', { value: TextDecoder })
