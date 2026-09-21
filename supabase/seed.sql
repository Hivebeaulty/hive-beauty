-- ============================================================================
-- SEED DE DEMONSTRAÇÃO — "Studio Bella" (Nail Designer)
-- Rode depois de criar um usuário de teste no Supabase Auth e substitua
-- ':demo_user_id' pelo UUID desse usuário antes de executar.
-- ============================================================================

do $$
declare
  demo_user_id uuid := ':demo_user_id';
  demo_company_id uuid;
  cat_id uuid;
  svc_alongamento uuid;
  svc_manutencao uuid;
  svc_banho_gel uuid;
  svc_esmaltacao uuid;
  cli_mariana uuid;
  cli_juliana uuid;
  cli_camila uuid;
  cli_fernanda uuid;
  member_id uuid;
begin
  insert into companies (name, niche_id, status, is_demo)
  values ('Studio Bella', (select id from niches where slug = 'nail_designer'), 'trial', true)
  returning id into demo_company_id;

  insert into company_members (company_id, user_id, role)
  values (demo_company_id, demo_user_id, 'owner')
  returning id into member_id;

  insert into service_categories (company_id, name, sort_order)
  values (demo_company_id, 'Unhas', 1) returning id into cat_id;

  insert into services (company_id, category_id, name, duration_minutes, price)
  values (demo_company_id, cat_id, 'Alongamento em Gel', 150, 150) returning id into svc_alongamento;
  insert into services (company_id, category_id, name, duration_minutes, price)
  values (demo_company_id, cat_id, 'Manutenção', 90, 90) returning id into svc_manutencao;
  insert into services (company_id, category_id, name, duration_minutes, price)
  values (demo_company_id, cat_id, 'Banho de Gel', 60, 70) returning id into svc_banho_gel;
  insert into services (company_id, category_id, name, duration_minutes, price)
  values (demo_company_id, cat_id, 'Esmaltação', 40, 40) returning id into svc_esmaltacao;

  insert into clients (company_id, name, phone, first_visit_at, last_visit_at)
  values (demo_company_id, 'Mariana', '11999990001', current_date - 300, current_date - 18) returning id into cli_mariana;
  insert into clients (company_id, name, phone, first_visit_at, last_visit_at)
  values (demo_company_id, 'Juliana', '11999990002', current_date - 200, current_date - 5) returning id into cli_juliana;
  insert into clients (company_id, name, phone, first_visit_at, last_visit_at)
  values (demo_company_id, 'Camila', '11999990003', current_date - 120, current_date - 47) returning id into cli_camila;
  insert into clients (company_id, name, phone, first_visit_at, last_visit_at)
  values (demo_company_id, 'Fernanda', '11999990004', current_date - 60, current_date - 2) returning id into cli_fernanda;

  insert into business_hours (company_id, weekday, start_time, end_time)
  select demo_company_id, w, '09:00', '18:00' from generate_series(1, 6) as w;

  insert into appointments (company_id, client_id, service_id, professional_member_id, scheduled_start, scheduled_end, status, price)
  values
    (demo_company_id, cli_mariana, svc_alongamento, member_id, now() + interval '1 day' + interval '10 hour', now() + interval '1 day' + interval '12.5 hour', 'confirmado', 150),
    (demo_company_id, cli_fernanda, svc_manutencao, member_id, now() + interval '2 hour', now() + interval '3.5 hour', 'agendado', 90);

  insert into payments (company_id, client_id, amount, method, status, paid_at)
  values (demo_company_id, cli_juliana, 90, 'pix', 'pago', now() - interval '5 day');

  insert into expenses (company_id, description, amount, payment_method, status, due_date)
  values (demo_company_id, 'Compra de materiais', 220, 'cartao', 'pago', current_date - 10);
end $$;
