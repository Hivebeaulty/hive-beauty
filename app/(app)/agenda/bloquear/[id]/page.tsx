"use client";

import { useParams } from "next/navigation";
import { BlockForm } from "@/components/agenda/block-form";

// Editar ou remover um bloqueio de horário.
export default function EditarBloqueioPage() {
  const { id } = useParams<{ id: string }>();
  return <BlockForm blockId={id} />;
}
