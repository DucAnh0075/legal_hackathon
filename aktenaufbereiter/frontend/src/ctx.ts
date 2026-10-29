import { createContext, useContext } from 'react'

export type OpenDoc = (docId: string, anchor?: string, opts?: { anchors?: string[]; original?: boolean }) => void
export const DocCtx = createContext<{ open: OpenDoc; caseId: string }>({ open: () => {}, caseId: '' })
export const useDocs = () => useContext(DocCtx)
