import { createContext, useContext } from 'react'

export type OpenDoc = (docId: string, anchor?: string, opts?: { anchors?: string[] }) => void
export const DocCtx = createContext<{ open: OpenDoc; caseId: string }>({ open: () => {}, caseId: '' })
export const useDocs = () => useContext(DocCtx)
