import bcrypt from 'bcrypt';
import { UserModel } from '../users/users.model';
import { ApiError } from '../../utils/ApiError';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  TokenPayload,
} from './auth.tokens';

const BCRYPT_ROUNDS = 12;

interface LoginResult {
  accessToken: string;
  refreshToken: string;
  user: { id: string; username: string; role: string; personId: string | null; mustChangePassword: boolean };
}

function payloadFor(user: { _id: unknown; role: TokenPayload['role']; person_id: unknown }): TokenPayload {
  return {
    sub: String(user._id),
    role: user.role,
    personId: user.person_id ? String(user.person_id) : null,
  };
}

export async function login(username: string, password: string): Promise<LoginResult> {
  const user = await UserModel.findOne({ username, is_active: true });
  if (!user) throw new ApiError('INVALID_CREDENTIALS');

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) throw new ApiError('INVALID_CREDENTIALS');

  const payload = payloadFor(user);
  const accessToken = signAccessToken(payload);
  const refreshToken = signRefreshToken(payload);
  user.refreshTokenHash = await bcrypt.hash(refreshToken, BCRYPT_ROUNDS);
  await user.save();

  return {
    accessToken,
    refreshToken,
    user: {
      id: String(user._id),
      username: user.username,
      role: user.role,
      personId: user.person_id ? String(user.person_id) : null,
      mustChangePassword: user.must_change_password,
    },
  };
}

export async function refresh(oldToken: string): Promise<{ accessToken: string; refreshToken: string }> {
  let decoded: TokenPayload;
  try {
    decoded = verifyRefreshToken(oldToken);
  } catch {
    throw new ApiError('TOKEN_INVALID');
  }

  const user = await UserModel.findById(decoded.sub);
  if (!user || !user.is_active || !user.refreshTokenHash) throw new ApiError('TOKEN_INVALID');

  const matches = await bcrypt.compare(oldToken, user.refreshTokenHash);
  if (!matches) throw new ApiError('TOKEN_INVALID');

  const payload = payloadFor(user);
  const accessToken = signAccessToken(payload);
  const refreshToken = signRefreshToken(payload);
  user.refreshTokenHash = await bcrypt.hash(refreshToken, BCRYPT_ROUNDS);
  await user.save();

  return { accessToken, refreshToken };
}

export async function logout(userId: string): Promise<void> {
  await UserModel.findByIdAndUpdate(userId, { refreshTokenHash: null });
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string
): Promise<void> {
  const user = await UserModel.findOne({ _id: userId, is_active: true });
  // Same code as a failed login, deliberately: a distinct "no such user" here
  // would turn an authenticated endpoint into a probe for valid user ids.
  if (!user) throw new ApiError('INVALID_CREDENTIALS');

  const ok = await bcrypt.compare(currentPassword, user.password_hash);
  if (!ok) throw new ApiError('INVALID_CREDENTIALS', 'Current password is incorrect');

  // Without this, a forced change is satisfiable by re-entering the password
  // the admin chose, which is exactly what must_change_password exists to stop.
  const unchanged = await bcrypt.compare(newPassword, user.password_hash);
  if (unchanged) {
    throw new ApiError('VALIDATION_ERROR', 'New password must differ from the current one');
  }

  user.password_hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  user.must_change_password = false;
  // Same invalidation resetPassword performs: a session opened with the old
  // credential must not be able to refresh itself past the change.
  user.refreshTokenHash = null;
  await user.save();
}
