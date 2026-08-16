import { Schema, model, Document, Types } from 'mongoose';
import { Role, ALL_ROLES } from '../../constants/roles';

export interface IUser extends Document {
  _id: Types.ObjectId;
  username: string;
  password_hash: string;
  role: Role;
  person_id: Types.ObjectId | null;
  must_change_password: boolean;
  is_active: boolean;
  deactivated_at: Date | null;
  deactivated_by: Types.ObjectId | null;
  deleted_at: Date | null;
  refreshTokenHash: string | null;
  createdAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    username: { type: String, required: true, unique: true },
    password_hash: { type: String, required: true },
    role: { type: String, enum: ALL_ROLES, required: true },
    person_id: { type: Schema.Types.ObjectId, ref: 'Person', default: null },
    must_change_password: { type: Boolean, default: false },
    is_active: { type: Boolean, default: true },
    deactivated_at: { type: Date, default: null },
    deactivated_by: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    deleted_at: { type: Date, default: null, index: true },
    refreshTokenHash: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const UserModel = model<IUser>('User', userSchema);
