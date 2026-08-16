import { randomBytes } from 'crypto';
import bcrypt from 'bcrypt';
import { Types } from 'mongoose';
import { gateKeyRepo } from './gateKeys.repository';
import { gateRepo } from './gates.repository';
import { ApiError } from '../../utils/ApiError';
import { GateContext } from '../../types';

const PREFIX_LITERAL = 'gk_live_';
const PREFIX_LEN = 8;
const SECRET_LEN = 32;

/** gk_live_<8 hex prefix><32 hex secret>. Fixed length so parsing is positional. */
function generateKey(): { key: string; prefix: string } {
  const prefix = randomBytes(PREFIX_LEN / 2).toString('hex');
  const secret = randomBytes(SECRET_LEN / 2).toString('hex');
  return { key: `${PREFIX_LITERAL}${prefix}${secret}`, prefix };
}

function parseKey(presented: string): { prefix: string } | null {
  if (!presented.startsWith(PREFIX_LITERAL)) return null;
  const rest = presented.slice(PREFIX_LITERAL.length);
  if (rest.length !== PREFIX_LEN + SECRET_LEN) return null;
  if (!/^[0-9a-f]+$/.test(rest)) return null;
  return { prefix: rest.slice(0, PREFIX_LEN) };
}

export const gateKeyService = {
  /**
   * Mints a key and revokes the gate's previous ones, so a gate has at most one
   * live terminal. Returns the plaintext exactly once — it is never recoverable.
   */
  async mint(gateId: string, userId: string) {
    if (!Types.ObjectId.isValid(gateId)) throw new ApiError('NOT_FOUND', 'Gate not found');
    const gate = await gateRepo.findById(gateId);
    if (!gate) throw new ApiError('NOT_FOUND', 'Gate not found');

    const { key, prefix } = generateKey();
    const key_hash = await bcrypt.hash(key, 12);

    await gateKeyRepo.deactivateForGate(gate._id);
    await gateKeyRepo.create({
      gate_id: gate._id,
      key_hash,
      key_prefix: prefix,
      created_by: new Types.ObjectId(userId),
    });

    console.log(`[gate-key] minted ${prefix} for gate '${gate.name}'`); // never log the key
    return {
      key,
      key_prefix: prefix,
      gate: {
        _id: String(gate._id),
        name: gate.name,
        type: gate.type,
        direction: gate.direction,
        location: gate.location,
      },
    };
  },

  /** Resolves a presented key to its gate, or null if it is not valid and active. */
  async authenticate(presented: string): Promise<GateContext | null> {
    const parsed = parseKey(presented);
    if (!parsed) return null;

    const record = await gateKeyRepo.findActiveByPrefix(parsed.prefix);
    if (!record) return null;

    // The prefix is only a lookup handle; the whole key is what gets compared.
    const ok = await bcrypt.compare(presented, record.key_hash);
    if (!ok) return null;

    const gate = await gateRepo.findById(String(record.gate_id));
    if (!gate) return null;

    await gateKeyRepo.touch(record._id);
    return {
      gateId: String(gate._id),
      name: gate.name,
      type: gate.type,
      direction: gate.direction,
      keyPrefix: record.key_prefix,
    };
  },
};
