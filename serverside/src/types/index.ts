import { Role } from '../constants/roles';

export interface AuthUser {
  userId: string;
  role: Role;
  personId: string | null;
}

export interface GateContext {
  gateId: string;
  name: string;
  // Mirrors gates.model.ts, which gained the gadget lane. Narrower here and
  // authenticate() cannot return the gate it just read.
  type: 'person' | 'vehicle' | 'gadget';
  direction: 'entry' | 'exit';
  keyPrefix: string;
}
