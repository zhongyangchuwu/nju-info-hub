import { authorizeSocialImport, importSocialMetadata, signSocialProducerBundle } from './commands.js';

const usage = `Private, offline social metadata operator tool
Required: SOCIAL_IMPORT_PROTECTED_ROOT=<canonical protected provider namespace>
  import <trust.json> <signed-operation.json> <public-safe-directory|-> <database>
  producer-sign <public-safe-directory> <producer-id> <private-key.pkcs8> <receipt-output.json>
  authorize <trust.json> <operation-draft.json> <approver-private-key.pkcs8> <signed-output.json>
All paths must be explicit, canonical, absolute and private outside the repository/protected namespace.
Producer signing is transport attestation only; authorization requires independent operator review.
Existing output documents are never overwritten. No network, provider access or default database.`;

const [command, ...arguments_] = process.argv.slice(2);
if (arguments_[0] === '--') arguments_.shift();
if (command === '--help' || command === 'help') {
  console.log(usage);
} else {
  try {
    const protectedRoot = process.env.SOCIAL_IMPORT_PROTECTED_ROOT;
    if (protectedRoot === undefined || arguments_.length !== 4) throw new Error('Invalid command');
    if (command === 'import') {
      const result = await importSocialMetadata({
        trust: arguments_[0]!,
        authorization: arguments_[1]!,
        bundleDirectory: arguments_[2] === '-' ? null : arguments_[2]!,
        database: arguments_[3]!,
        protectedRoot,
      });
      console.log(JSON.stringify(result));
    } else if (command === 'producer-sign') {
      await signSocialProducerBundle({
        bundleDirectory: arguments_[0]!,
        producerId: arguments_[1]!,
        privateKey: arguments_[2]!,
        output: arguments_[3]!,
        protectedRoot,
      });
      console.log(JSON.stringify({ status: 'signed-transport' }));
    } else if (command === 'authorize') {
      await authorizeSocialImport({
        trust: arguments_[0]!,
        operation: arguments_[1]!,
        privateKey: arguments_[2]!,
        output: arguments_[3]!,
        protectedRoot,
      });
      console.log(JSON.stringify({ status: 'signed-authorization' }));
    } else {
      throw new Error('Invalid command');
    }
  } catch {
    // Never print paths, parsed values, key material, upstream errors or SQLite diagnostics.
    console.error('Social import command rejected. Check private storage, current trust and signed inputs.');
    process.exitCode = 1;
  }
}
