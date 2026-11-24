declare module 'verovio/wasm' {
  const create: () => Promise<unknown>
  export default create
}

declare module 'verovio/esm' {
  interface VrvToolkit {
    loadData(xml: string): boolean
    setOptions(opts: Record<string, unknown>): void
    renderToSVG(pageNo?: number, xmlDeclaration?: boolean): string
    getPageCount(): number
    getPageWithElement(xmlId: string): number
    getTimeForElement(xmlId: string): number
    edit(editorAction: Record<string, unknown>): string
    destroy(): void
  }
  const VerovioToolkit: new (module: unknown) => VrvToolkit
  export { VerovioToolkit }
}
