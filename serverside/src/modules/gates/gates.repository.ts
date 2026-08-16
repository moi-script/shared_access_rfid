import { GateModel } from './gates.model';

export const gateRepo = {
  list: () => GateModel.find().lean(),
  findById: (id: string) => GateModel.findById(id).lean(),
};
