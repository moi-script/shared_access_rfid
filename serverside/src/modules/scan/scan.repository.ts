import { ScanLogModel, IScanLog } from './scan.model';

export const scanRepo = {
  createLog: (data: Partial<IScanLog>) => ScanLogModel.create(data),
};
