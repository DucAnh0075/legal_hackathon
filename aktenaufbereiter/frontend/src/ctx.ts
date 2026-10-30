import { createContext, useContext } from 'react'
import type { Doc } from './api'

export type OpenDoc = (docId: string, anchor?: string, opts?: { anchors?: string[] }) => void
export const DocCtx = createContext<{ open: OpenDoc; caseId: string; dokumente: Doc[] }>({ open: () => {}, caseId: '', dokumente: [] })
export const useDocs = () => useContext(DocCtx)
