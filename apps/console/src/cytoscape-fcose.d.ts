// cytoscape-fcose does not ship TypeScript types; this declaration satisfies the compiler.
declare module 'cytoscape-fcose' {
  import cytoscape from 'cytoscape';
  const fcose: cytoscape.Ext;
  export default fcose;
}
