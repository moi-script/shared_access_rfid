import { gateRepo } from './gates.repository';
import { ApiError } from '../../utils/ApiError';

export const gateService = {
  list: () => gateRepo.list(),
  async get(id: string) {
    const gate = await gateRepo.findById(id);
    if (!gate) throw new ApiError('NOT_FOUND', 'Gate not found');
    return gate;
  },
};
