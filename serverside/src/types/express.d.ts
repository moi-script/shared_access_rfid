import { AuthUser, GateContext } from './index';

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      gate?: GateContext;
    }
  }
}

export {};
