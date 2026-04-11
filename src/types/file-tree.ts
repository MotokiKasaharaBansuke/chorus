export interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymlink: boolean;
  children: FileNode[] | null;
}
