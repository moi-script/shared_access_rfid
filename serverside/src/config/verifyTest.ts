import { connectDB, disconnectDB } from './db';
import { UserModel } from '../modules/users/users.model';
import { PersonModel } from '../modules/persons/persons.model';

(async () => {
  await connectDB();
  const users = await UserModel.find()
    .select('username role person_id is_active must_change_password')
    .lean();
  const persons = await PersonModel.find({ type: 'student' })
    .select('full_name id_number department_section rfid_uid status')
    .lean();

  console.log('\n=== USERS ===');
  console.table(
    users.map((u) => ({
      username: u.username,
      role: u.role,
      person_id: String(u.person_id),
      active: u.is_active,
    }))
  );

  console.log('\n=== STUDENT PERSONS ===');
  console.table(
    persons.map((p) => ({
      name: p.full_name,
      id: p.id_number,
      section: p.department_section,
      rfid: p.rfid_uid,
      status: p.status,
    }))
  );

  await disconnectDB();
})();
