import { isExcluded } from '../../src/state/exclude';
import { eq, section } from './harness';

const DEFAULT_GLOBS = ['**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/id_rsa*', '**/*secret*', '**/*credential*'];

export function run(): void {
  section('isExcluded: matches the default sensitive-file patterns', () => {
    eq('top-level .env', isExcluded('.env', DEFAULT_GLOBS), true);
    eq('nested .env', isExcluded('config/.env', DEFAULT_GLOBS), true);
    eq('.env.local', isExcluded('.env.local', DEFAULT_GLOBS), true);
    eq('a .pem file', isExcluded('certs/server.pem', DEFAULT_GLOBS), true);
    eq('id_rsa', isExcluded('.ssh/id_rsa', DEFAULT_GLOBS), true);
    eq('id_rsa.pub', isExcluded('.ssh/id_rsa.pub', DEFAULT_GLOBS), true);
    eq('a secret-named file', isExcluded('config/my-secret-key.txt', DEFAULT_GLOBS), true);
    eq('a credential-named file', isExcluded('aws-credentials.json', DEFAULT_GLOBS), true);
  });

  section('isExcluded: does not match unrelated files, including partial name collisions', () => {
    eq('a normal source file', isExcluded('src/index.ts', DEFAULT_GLOBS), false);
    eq('"myenv" is not ".env"', isExcluded('myenv.txt', DEFAULT_GLOBS), false);
    eq('"secret" only in a directory name, not the filename', isExcluded('secrets/config.json', DEFAULT_GLOBS), false);
    eq('.env.local.bak does not match the bare .env pattern alone', isExcluded('.env.local.bak', ['**/.env']), false);
  });

  section('isExcluded: null path never matches', () => {
    eq('null path', isExcluded(null, DEFAULT_GLOBS), false);
  });

  section('isExcluded: backslash paths are normalized before matching', () => {
    eq('windows-style separators', isExcluded('config\\.env', DEFAULT_GLOBS), true);
  });

  section('isExcluded: an empty glob list never excludes anything', () => {
    eq('empty globs', isExcluded('.env', []), false);
  });
}
