import { ClienteForm } from "@/components/cliente-form";

export default function NovaClientePage() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-charcoal-900">Nova cliente</h1>
      <ClienteForm />
    </div>
  );
}
