// Authoring-time declaration; SQL imports are embedded by the build.
declare module "*.sql" {
  const text: string;
  export default text;
}
