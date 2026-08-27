export const MINIMUM_NODE_MAJOR = 20;

export function isSupportedNodeVersion(version: string): boolean {
  const [major] = version.split(".");

  return (
    major !== undefined &&
    /^\d+$/u.test(major) &&
    Number(major) >= MINIMUM_NODE_MAJOR
  );
}
