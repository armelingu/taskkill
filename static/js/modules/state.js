/**
 * Estado mutável compartilhado entre os módulos de feature (tasks, projects,
 * dashboard, graph) e o main. É um singleton: todos importam o MESMO objeto,
 * então reatribuições (ex.: state.tasksData = ...) são vistas por todos.
 *
 * Mantido pequeno de propósito — só o que precisa cruzar fronteiras de módulo.
 */
export const state = {
    tasksData: {},          // { projeto: [ {id, text, completed, due_date, ...}, ... ] }
    currentCategory: null,  // projeto selecionado (nome real, ou chave de compartilhado)
    currentWeekDate: null,  // data ISO YYYY-MM-DD selecionada (visão semana)
    currentWeekStart: null, // segunda-feira ISO da semana visível na faixa
    currentTag: null,       // #tag selecionada (vinda do grafo)

    // Compartilhamento (colaboração leve). Mantidos FORA de tasksData de propósito:
    // assim grafo/semana/dashboard/insights (que leem tasksData) seguem só com o
    // que é meu. O "modo compartilhado" é detectado por shares[currentCategory].
    shares: {},             // { chave: { ownerId, ownerName, project, role } }
    sharedTasks: {},        // { chave: [ tarefas do projeto do dono ] }
};
