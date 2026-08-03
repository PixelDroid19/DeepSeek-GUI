# Diseno del harness de programacion Kun

Fecha: 2026-08-03
Estado: pendiente de revision del usuario
Repositorio: `/home/monasterios/Documents/IA/DeepSeek-GUI`

## 1. Resultado buscado

Convertir el runtime Kun existente en un harness de programacion reproducible y
agnostico al modelo que aumente la tasa de tareas resueltas en distintas familias
de benchmarks sin incorporar respuestas, parches de referencia ni reglas
especificas para instancias conocidas.

El primer modelo de medicion real sera `deepseek-v4-flash`. La comparacion
principal enfrentara el bucle normal de Kun contra el nuevo modo adaptativo usando
el mismo modelo, protocolo, presupuesto, entorno y tareas. El objetivo no es
garantizar una mejora en cada tarea individual, sino mejorar la puntuacion agregada
sin regresiones materiales por familia de benchmark.

## 2. Restricciones del repositorio

- Kun seguira siendo el unico runtime vivo. No se agregara otro provider, selector
  de runtime, proceso agente ni logica de agente en el renderer.
- Las extensiones seguiran el orden indicado por `docs/AGENTS.md`: contratos,
  dominio/servicios/puertos/adaptadores, rutas y mapeo de GUI solo si es necesario.
- La V1 sera headless y no agregara un panel nuevo. La GUI consumira los eventos
  existentes cuando resulte util en una fase posterior.
- Se preservara el prefijo inmutable y el historial append-only para mantener la
  cache de DeepSeek.
- En trials headless del harness, las credenciales solo entraran mediante
  variables de entorno. Nunca se persistiran en manifests de pruebas, trazas,
  errores, snapshots o commits. Esta regla no cambia en la V1 la configuracion
  interactiva ya existente de la GUI.
- El harness no podra leer soluciones oracle ni verificadores privados durante la
  ejecucion del agente.

## 3. Base existente que se reutiliza

Kun ya proporciona:

- `ModelClient` y `DeepseekCompatModelClient` para modelos intercambiables.
- Tool calls tipadas, aprobaciones, niveles de riesgo y sandbox de workspace.
- Historial append-only, reparacion de tool-call/tool-result y conservacion de
  `reasoning_content` en rondas DeepSeek con herramientas.
- Context compaction, memoria con procedencia, ledger de workspace y playbooks.
- Delegacion y pipeline riguroso planner -> executor -> verifier -> reviewer.
- Suites de evaluacion mecanicas y telemetria de uso/cache/coste.

El trabajo nuevo no duplicara esas piezas. Cerrara los huecos que hoy impiden
considerarlas un harness general medible: especificacion normalizada de tarea,
control adaptativo, deteccion de estancamiento, puerta determinista de finalizacion,
traza reproducible y adaptadores de benchmark.

## 4. No objetivos de la V1

- Entrenar o afinar pesos de modelos.
- Prometer que un modelo debil igualara a uno mas capaz.
- Optimizar prompts contra respuestas publicas concretas.
- Ejecutar varios modelos distintos dentro de una comparacion declarada como
  `deepseek-v4-flash`.
- Construir una plataforma generica de 3D, SVG o computer-use.
- Sustituir Harbor, Docker o los evaluadores oficiales de cada benchmark.
- Exponer chain-of-thought privada en reportes o GUI.

## 5. Arquitectura

### 5.1 Nucleo y puertos

La extension mantiene la arquitectura hexagonal de Kun.

El nucleo incorporara estos contratos versionados:

```ts
type HarnessTaskSpecV1 = {
  version: 1
  id: string
  objective: string
  acceptanceCriteria: AcceptanceCriterion[]
  verification: VerificationCheck[]
  constraints: TaskConstraint[]
  budgets: TrialBudgets
  executionPolicy: 'normal' | 'rigorous' | 'adaptive'
  benchmark?: {
    family: string
    dataset: string
    version: string
    taskId: string
  }
}

type HarnessTrialManifestV1 = {
  task: HarnessTaskSpecV1
  workspaceRoot: string
  model: string
  endpointFormat: 'chat_completions' | 'responses' | 'messages'
  harnessCommit: string
  environmentDigest: string
  remoteModelRevision?: string
  seed?: number
}

type AcceptanceCriterion = {
  id: string
  description: string
  required: boolean
  acceptedEvidenceKinds: Array<'command' | 'diff' | 'artifact' | 'static-report'>
}

type VerificationCheck = {
  id: string
  command: string
  expectation: { kind: 'exit-zero' } | { kind: 'contains'; text: string }
  required: boolean
  timeoutMs: number
}

type TaskConstraint = {
  kind: 'allowed-path' | 'forbidden-path' | 'network' | 'custom'
  value: string
}

type TrialBudgets = {
  wallTimeMs: number
  maxModelSteps: number
  maxInputTokens: number
  maxOutputTokens: number
  maxCostUsd: number
  maxRecoveryRounds: number
}
```

`HarnessTaskSpecV1` se asociara opcionalmente al turno. Los turnos normales
continuaran funcionando sin este contrato.

Puertos nuevos o extendidos:

- `TaskSource`: entrega instrucciones y artefactos permitidos sin revelar oracles.
- `TrialRecorder`: escribe una traza normalizada, redactada y reproducible.
- `CompletionGate`: decide `ship | ship_with_warnings | fix | replan | fail |
  inconclusive` a partir de evidencia mecanica, no de la narrativa de un modelo.
- `BenchmarkReporter`: traduce el resultado interno al formato requerido por el
  evaluador externo.

Los proveedores de modelo, sandbox, benchmark y almacenamiento seguiran siendo
adaptadores. El dominio no importara Harbor, Docker ni SDKs de un proveedor.

### 5.2 Controlador adaptativo

El modo `adaptive` ejecutara una maquina de estados por tarea:

```text
intake -> environment discovery -> repository map -> plan -> execute
   -> verify -> ship
          |        ^
          v        |
       diagnose -> recover -> execute
          |
          v
         fail con evidencia
```

Estados y reglas:

1. `intake`: normaliza objetivo, restricciones, presupuesto y criterios.
2. `discover`: comprueba SO, shell, herramientas, versiones, Git y comandos de
   prueba antes de editar.
3. `map`: recupera solo simbolos, archivos y dependencias relevantes.
4. `plan`: produce pasos y criterios verificables; no repite exploracion ya
   registrada.
5. `execute`: usa el AgentLoop actual y registra cambios/evidencia.
6. `verify`: ejecuta verificadores mecanicos y despues el verificador adversarial.
7. `diagnose`: clasifica el fallo antes de gastar otro intento.
8. `recover`: selecciona una estrategia distinta y acotada.
9. `ship/fail`: termina unicamente mediante `CompletionGate`.

Para tareas sencillas se usa un solo ejecutor. El pipeline riguroso se activa
cuando la tarea es multiarchivo, de alto riesgo, supera un umbral de pasos o entra
en estancamiento. Esto evita pagar siempre cuatro roles.

### 5.3 Deteccion de estancamiento

El detector usara evidencia durable, no solo texto del modelo. Disparadores:

- mismo tool + argumentos equivalentes repetidos sin nuevo resultado;
- mismo error normalizado despues de dos intentos;
- ausencia de diff y de nueva evidencia durante N pasos;
- regresion del numero de checks aprobados;
- lectura repetida de los mismos archivos sin hipotesis nueva;
- consumo del 70% del presupuesto sin avance verificable;
- finalizacion declarada con criterios aun no cubiertos.

La recuperacion sera progresiva:

1. resumir estado, intentos y evidencia en un checkpoint;
2. pedir a un critico aislado una clasificacion del bloqueo;
3. generar una hipotesis alternativa que no repita las descartadas;
4. ejecutar una ronda rigurosa;
5. finalizar como fallo comprobado si se agota el presupuesto.

No habra bucles de reintentos ilimitados.

### 5.4 Puerta determinista de finalizacion

El pipeline actual puede persistir evals fallidos y aun aceptar un `ship` del
reviewer. La V1 cambiara esta autoridad: el reviewer aconseja, pero
`CompletionGate` decide.

Un resultado no puede ser `ship` si ocurre cualquiera de estas condiciones:

- un check obligatorio falla o no se ejecuto;
- el build/test oficial permitido no termina correctamente;
- un criterio obligatorio no referencia evidencia ejecutada;
- la suite cambio durante el turno sin autorizacion del TaskSpec;
- el diff contiene archivos fuera del scope permitido;
- existe un error de herramienta pendiente que afecta la validacion;
- el workspace final no coincide con el artefacto evaluado.

Cada `CriterionResult` incluira `evidenceIds[]`. La evidencia podra referenciar
resultados de comandos, hashes de artefactos, diffs o reportes estaticos. El texto
autodeclarado por un agente no cuenta como evidencia suficiente.

Checks recomendados pero no obligatorios pueden producir `ship_with_warnings`; en
benchmarks pass/fail este estado se reportara como el resultado mecanico real, no
se maquillara.

### 5.5 Traza reproducible

La traza se derivara de los items, eventos y telemetria existentes; no se creara
una segunda historia contradictoria. El exportador normalizara:

- manifest de trial y hashes de entorno;
- acciones/observaciones con ids estables;
- archivos leidos/modificados y diff final;
- checkpoints, hipotesis y transiciones de estado;
- resultados de checks y evidencia;
- modelo real usado en cada etapa;
- tokens, cache, coste estimado, duracion y motivo de terminacion.

Todos los campos pasan por redaccion antes de persistirse. La respuesta de error
del proveedor tambien debe redactarse antes de entrar en items o trazas.

El formato de exportacion sera JSONL propio y se ofrecera un exportador ATIF para
interoperar con Harbor sin hacer que el dominio dependa de Harbor.

## 6. Politica de modelos y prueba justa

El harness es agnostico al modelo a nivel contractual, no a nivel de calidad.
Cada adaptador declara capacidades reales: tool calls, JSON, thinking, streaming,
contexto y protocolo.

Para el experimento inicial:

- todos los roles se bloquean a `deepseek-v4-flash`;
- thinking se habilita con esfuerzo `max` en tareas agenticas y `high` en etapas
  auxiliares;
- no se permite fallback silencioso a V4 Pro;
- Chat Completions es el protocolo inicial;
- Responses solo se habilita si una prueba de capacidad contra el host oficial
  confirma tool calls, streaming, uso y continuacion;
- `reasoning_content` de rondas con tool calls se conserva conforme al protocolo
  de DeepSeek;
- temperatura/top_p no se usan en thinking mode porque el proveedor indica que no
  tienen efecto.

La clave se leera desde `DEEPSEEK_API_KEY`. Los comandos de reproduccion usaran el
nombre de la variable, nunca su valor.

El manifest registrara el id remoto y la revision si la API la expone. Si no la
expone, `remoteModelRevision` quedara ausente y el reporte mostrara explicitamente
que la revision es desconocida junto con la fecha UTC del trial; no se inventara
una version a partir del nombre comercial.

## 7. Adaptadores de benchmark

### 7.1 Contrato comun

Un adaptador solo puede:

- convertir una tarea publica/privada a `HarnessTaskSpecV1`;
- preparar el workspace autorizado;
- iniciar el trial con presupuestos fijados;
- invocar el verificador externo despues de terminar;
- emitir la puntuacion y artefactos permitidos.

No puede inyectar soluciones, tests ocultos, patrones por task id ni instrucciones
que revelen el oracle.

### 7.2 V1

1. Adaptador local para tareas pequenas y regresiones del propio Kun.
2. Adaptador Harbor/ATIF para ejecutar Kun como agente instalado o externo.
3. Compatibilidad inicial con una muestra versionada de Terminal-Bench 2.1.
4. Adaptadores posteriores para SWE-bench Pro/Verified y LiveCodeBench, reutilizando
   el mismo nucleo y sin cambiar prompts por dataset.

Harbor/Docker seguiran siendo responsables de la imagen y el verificador. Kun solo
recibira el workspace y las instrucciones permitidas.

## 8. Laboratorio de evaluacion A/B

Cada tarea se ejecutara bajo dos condiciones:

- `baseline`: AgentLoop normal con herramientas existentes;
- `harness`: controlador adaptativo, stall recovery y CompletionGate.

Variables bloqueadas:

- mismo `deepseek-v4-flash` y protocolo;
- misma imagen, tarea y revision del dataset;
- mismo limite de tiempo, tokens y coste;
- mismas herramientas disponibles y misma politica de red;
- misma cantidad de intentos o presupuesto agregado;
- verificadores externos identicos.

Metricas primarias:

- pass rate oficial;
- delta de pass rate por familia;
- tareas mejoradas y tareas regresadas;
- falsos `completed` evitados;
- recuperacion despues del primer fallo;
- exito multiarchivo;
- coste, tokens y tiempo por tarea aprobada.

Metricas secundarias:

- errores de herramientas;
- ciclos repetidos detectados;
- cobertura de criterios con evidencia;
- cache hit/miss;
- frecuencia y utilidad de escalamiento riguroso.

La afirmacion de mejora requiere como minimo:

1. pruebas unitarias/integracion locales en verde;
2. smoke real con V4 Flash y tool calls;
3. A/B sobre tareas no usadas para escribir prompts;
4. mejora agregada con intervalos o repeticiones cuando el coste lo permita;
5. publicacion de regresiones, no solo de exitos.

La primera corrida en red tendra un limite de gasto configurable y conservador,
con valor predeterminado de USD 5. El trial se detendra antes de excederlo segun
el coste estimado y el proveedor seguira siendo la autoridad de facturacion.

## 9. Seguridad y anti-gaming

- Verificador post-run separado del proceso agente cuando el benchmark lo permita.
- Tests/soluciones privadas fuera del filesystem y contexto visibles al agente.
- Hash de suite antes/despues; alteracion no autorizada bloquea `ship`.
- Redaccion de Authorization, API keys, bearer tokens, URLs firmadas y cuerpos de
  error antes de logs/trazas.
- Sandbox y limites de CPU, memoria, disco, red, procesos y tiempo por trial.
- Manifest firmado por hashes de tarea, entorno, modelo, harness y politicas.
- Deteccion de lectura de rutas prohibidas y de manipulacion del evaluador.
- Dataset publico para desarrollo; conjunto privado/rotado para confirmar
  generalizacion.

La clave compartida para esta tarea se considera expuesta por haber aparecido en
una conversacion. No se guardara y debe rotarse despues de la validacion.

## 10. Errores y degradacion

- `401/402`: detener trials; no reintentar ni registrar credenciales.
- `429/5xx`: backoff con jitter, limite de reintentos y registro estructurado.
- tool call JSON invalida: reparar una vez; despues pedir regeneracion tipada.
- perdida de streaming: reanudar solo si el protocolo y el idempotency contract lo
  permiten; de lo contrario registrar trial fallido.
- contexto cercano al limite: compactar conservando decisiones, errores pendientes,
  evidencia y tool-call reasoning requerido por DeepSeek.
- verificador indisponible: resultado `inconclusive`, nunca `pass`.
- benchmark defectuoso: conservar evidencia y clasificar por separado sin cambiar
  unilateralmente la puntuacion oficial.

## 11. Plan de entrega por fases

### Fase A: seguridad y contrato de trial

- Redactar cuerpos de error del proveedor.
- Agregar TaskSpec, TrialManifest, evidencia y schemas de trace.
- Mantener compatibilidad total con turnos existentes.

### Fase B: CompletionGate

- Vincular criterios con evidencia mecanica.
- Impedir `ship` con checks obligatorios fallidos o suite alterada.
- Agregar tests de regresion al pipeline riguroso.

### Fase C: controlador adaptativo

- Maquina de estados, detector de estancamiento y estrategias de recuperacion.
- Escalamiento a pipeline riguroso usando el mismo modelo bloqueado.
- Presupuestos de pasos, tiempo, tokens y coste.

### Fase D: trace y CLI

- `kun harness run <manifest>`.
- `kun harness compare <suite>` para baseline/harness.
- JSONL reproducible, resumen Markdown y exportacion ATIF.

### Fase E: adaptador Harbor y pruebas reales

- Ejecutar Kun dentro del entorno de tarea sin acceso al verifier privado.
- Smoke oficial con V4 Flash.
- Subconjunto versionado de Terminal-Bench 2.1 y A/B controlado.
- Registrar puntuacion, coste, tiempo, fallos y regresiones.

## 12. Validacion tecnica

Pruebas automatizadas:

- schemas invalidos y compatibilidad de versiones;
- cada disparador de estancamiento y sus falsos positivos;
- eval obligatorio fallido nunca produce `ship`;
- criterio sin evidencia nunca produce `ship`;
- suite alterada durante el trial bloquea finalizacion;
- todos los roles usan el modelo fijado en el manifest;
- ningun error/traza contiene secretos conocidos;
- replay produce las mismas transiciones con adapters falsos;
- budgets cortan correctamente el trial;
- exportacion ATIF valida.

Validacion del repositorio:

```bash
npm run typecheck
npm test
npm run build
```

Validacion real:

1. probar autenticacion/model listing sin imprimir secretos;
2. ejecutar Chat Completions streaming con V4 Flash;
3. ejecutar al menos un tool call en thinking mode y comprobar continuidad;
4. probar JSON y cache telemetry;
5. correr baseline y harness sobre la misma micro-suite;
6. correr el subconjunto Harbor/Terminal-Bench dentro del presupuesto;
7. revisar manualmente las trazas de mejoras y regresiones.

## 13. Criterios de aceptacion

La V1 esta terminada cuando:

- Kun sigue siendo el unico runtime y turnos existentes no regresan;
- V4 Flash completa un trial real con herramientas y thinking;
- el harness impide al menos un falso `completed` demostrado por test;
- el detector sale de un bucle demostrado y adopta una estrategia distinta;
- baseline y harness se comparan bajo manifest identico;
- el reporte incluye pass rate, delta, coste, tiempo y regresiones;
- ninguna credencial aparece en repo, logs o trazas;
- typecheck, tests y build pasan;
- existe evidencia A/B real; no se afirma mejora solo por pruebas sinteticas.

## 14. Riesgos y decisiones pendientes

- No se garantiza mejorar cada benchmark; se optimiza generalizacion agregada.
- El pipeline riguroso puede costar mas que el beneficio en tareas pequenas; por
  eso el modo adaptativo decide cuando escalar.
- La implementacion actual de Responses no equivale a soporte confirmado del host
  DeepSeek; Chat Completions es la base hasta verificarlo.
- USD 5 es un limite inicial de seguridad, no una estimacion del coste total de una
  evaluacion completa.
- Los benchmarks publicos pueden estar contaminados; se requiere una muestra
  privada o rotada para sostener conclusiones fuertes.
- V4 Flash es el primer modelo, no una dependencia del dominio. Otros modelos se
  agregaran mediante el mismo `ModelClient` y perfiles de capacidades.
