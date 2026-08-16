import { Role } from '../constants/roles';

export interface AuthUser {
  userId: string;
  role: Role;
  personId: string | null;
}

export interface GateContext {
  gateId: string;
  name: string;
  type: 'person' | 'vehicle';
  direction: 'entry' | 'exit';
  keyPrefix: string;
}
