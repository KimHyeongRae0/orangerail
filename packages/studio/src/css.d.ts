/** Ambient types for CSS imports processed by Vite. */
declare module '*.module.css' {
  const classes: Record<string, string>;
  export default classes;
}

declare module '*.css';
