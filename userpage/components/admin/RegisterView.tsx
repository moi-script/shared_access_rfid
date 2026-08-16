"use client";

import { useState } from "react";
import PersonForm from "@/components/PersonForm";
import ImportPersons from "@/components/ImportPersons";
import VehicleApplicationForm from "@/components/vehicles/VehicleApplicationForm";
import GadgetForm, { type GadgetRecord } from "@/components/gadgets/GadgetForm";
import type { PersonRecord } from "@/components/RegistrationForm";
import { getStoredUser, type Role } from "@/lib/auth";
import { canRegisterGadgets, canRegisterVehicles, personTypesFor } from "@/lib/permissions";
import Notice from "@/components/Notice";
import { TfiCar, TfiDesktop, TfiImport, TfiUser } from "react-icons/tfi";

type Panel = "single" | "import" | "vehicle" | "gadget" | null;

export default function RegisterView() {
  const [panel, setPanel] = useState<Panel>(null);
  const [lastCreated, setLastCreated] = useState<PersonRecord | null>(null);
  const [importedAt, setImportedAt] = useState<number | null>(null);
  const [lastVehicle, setLastVehicle] = useState<string | null>(null);
  const [lastGadget, setLastGadget] = useState<string | null>(null);

  // Remounting clears the form between registrations.
  const [formKey, setFormKey] = useState(0);
  const [vehicleFormKey, setVehicleFormKey] = useState(0);
  const [gadgetFormKey, setGadgetFormKey] = useState(0);

  // Fails closed: if somehow no stored user is found, personTypesFor("staff")
  // returns [] and canRegisterVehicles("staff") is false, so every panel
  // button hides rather than silently offering a form the server will reject.
  const myRole = (getStoredUser()?.role ?? "staff") as Role;
  const canPerson = personTypesFor(myRole).length > 0;
  const canVehicle = canRegisterVehicles(myRole);
  const canGadget = canRegisterGadgets(myRole);

  /** Only one notice at a time — the newest action is the one being reported. */
  function clearNotices() {
    setLastCreated(null);
    setImportedAt(null);
    setLastVehicle(null);
    setLastGadget(null);
  }

  function handleCreated(person: PersonRecord) {
    clearNotices();
    setLastCreated(person);
    setFormKey((k) => k + 1);
  }

  function handleVehicleCreated(vehicle: { plate_number: string }) {
    clearNotices();
    setLastVehicle(vehicle.plate_number);
    setVehicleFormKey((k) => k + 1);
  }

  function handleGadgetCreated(gadget: GadgetRecord) {
    clearNotices();
    setLastGadget(`${gadget.brand_model} (${gadget.serial_number})`);
    setGadgetFormKey((k) => k + 1);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-xl font-700 text-navy">Register</h1>
        <p className="text-sm text-ink-soft">
          Create a person record and assign their RFID card. One card per person works at
          every campus gate.
        </p>
      </div>

      {lastCreated && (
        <Notice tone="info" className="text-sm text-ink">
          Registered {lastCreated.full_name}.{" "}
          {lastCreated.login_created
            ? `They can sign in with ID number ${lastCreated.id_number}.`
            : "No login was created — add one from the Accounts tab."}{" "}
          The form is ready for the next person.
        </Notice>
      )}
      {importedAt && (
        <Notice tone="info" className="text-sm text-ink">
          Import finished. Check the Directory tab to review the new records.
        </Notice>
      )}
      {lastVehicle && (
        <Notice tone="info" className="text-sm text-ink">
          Registered vehicle {lastVehicle}. The form is ready for the next application.
        </Notice>
      )}
      {lastGadget && (
        <Notice tone="info" className="text-sm text-ink">
          Registered {lastGadget}. It will show on the owner&apos;s card tap at any gate.
        </Notice>
      )}

      <div className="flex gap-2">
        {canPerson && (
          <button
            onClick={() => setPanel("single")}
            className={
              panel === "single"
                ? "flex items-center gap-2 rounded-xl bg-navy px-4 py-2 text-sm font-600 text-white"
                : "flex items-center gap-2 rounded-xl border border-line bg-white px-4 py-2 text-sm font-600 text-ink-soft transition hover:text-navy"
            }
          >
            <TfiUser aria-hidden className="h-3.5 w-3.5" />
            Single person
          </button>
        )}
        {canPerson && (
          <button
            onClick={() => setPanel("import")}
            className={
              panel === "import"
                ? "flex items-center gap-2 rounded-xl bg-navy px-4 py-2 text-sm font-600 text-white"
                : "flex items-center gap-2 rounded-xl border border-line bg-white px-4 py-2 text-sm font-600 text-ink-soft transition hover:text-navy"
            }
          >
            <TfiImport aria-hidden className="h-3.5 w-3.5" />
            Bulk import
          </button>
        )}
        {canVehicle && (
          <button
            onClick={() => setPanel("vehicle")}
            className={
              panel === "vehicle"
                ? "flex items-center gap-2 rounded-xl bg-navy px-4 py-2 text-sm font-600 text-white"
                : "flex items-center gap-2 rounded-xl border border-line bg-white px-4 py-2 text-sm font-600 text-ink-soft transition hover:text-navy"
            }
          >
            <TfiCar aria-hidden className="h-3.5 w-3.5" />
            Vehicle
          </button>
        )}
        {canGadget && (
          <button
            onClick={() => setPanel("gadget")}
            className={
              panel === "gadget"
                ? "flex items-center gap-2 rounded-xl bg-navy px-4 py-2 text-sm font-600 text-white"
                : "flex items-center gap-2 rounded-xl border border-line bg-white px-4 py-2 text-sm font-600 text-ink-soft transition hover:text-navy"
            }
          >
            <TfiDesktop aria-hidden className="h-3.5 w-3.5" />
            Device
          </button>
        )}
      </div>

      {panel === "single" && canPerson && (
        <PersonForm
          key={formKey}
          onCreated={handleCreated}
          onClose={() => setPanel(null)}
        />
      )}

      {panel === "import" && canPerson && (
        <ImportPersons
          onDone={() => {
            setImportedAt(Date.now());
            setLastCreated(null);
          }}
          onClose={() => setPanel(null)}
        />
      )}

      {panel === "vehicle" && canVehicle && (
        <VehicleApplicationForm
          key={vehicleFormKey}
          onCreated={handleVehicleCreated}
          onClose={() => setPanel(null)}
        />
      )}

      {panel === "gadget" && canGadget && (
        <GadgetForm
          key={gadgetFormKey}
          onCreated={handleGadgetCreated}
          onClose={() => setPanel(null)}
        />
      )}
    </div>
  );
}
